import { Request, Response, NextFunction } from 'express'
import { RateLimiterManager } from '../../utils/rateLimit'
import chatflowsService from '../../services/chatflows'
import logger from '../../utils/logger'
import predictionsServices from '../../services/predictions'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { StatusCodes } from 'http-status-codes'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { v4 as uuidv4 } from 'uuid'
import { getErrorMessage } from '../../errors/utils'

// 1. Add a wrapper to enforce timeouts on the prediction
const withTimeout = (promise: Promise<any>, ms: number) => {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms)
        )
    ]);
};
import { MODE } from '../../Interface'

// Send input message and get prediction result (External)
const createPrediction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: predictionsController.createPrediction - id not provided!`
            )
        }
        if (!req.body) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: predictionsController.createPrediction - body not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId

        const chatflow = await chatflowsService.getChatflowById(req.params.id, workspaceId)
        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${req.params.id} not found`)
        }
        let isDomainAllowed = true
        let unauthorizedOriginError = 'This site is not allowed to access this chatbot'
        logger.info(`[server]: Request originated from ${req.headers.origin || 'UNKNOWN ORIGIN'}`)
        if (chatflow.chatbotConfig) {
            const parsedConfig = JSON.parse(chatflow.chatbotConfig)
            // check whether the first one is not empty. if it is empty that means the user set a value and then removed it.
            const isValidAllowedOrigins = parsedConfig.allowedOrigins?.length && parsedConfig.allowedOrigins[0] !== ''
            unauthorizedOriginError = parsedConfig.allowedOriginsError || 'This site is not allowed to access this chatbot'
            if (isValidAllowedOrigins && req.headers.origin) {
                const originHeader = req.headers.origin
                const origin = new URL(originHeader).host
                isDomainAllowed =
                    parsedConfig.allowedOrigins.filter((domain: string) => {
                        try {
                            const allowedOrigin = new URL(domain).host
                            return origin === allowedOrigin
                        } catch (e) {
                            return false
                        }
                    }).length > 0
            }
        }
        if (isDomainAllowed) {
            const streamable = await chatflowsService.checkIfChatflowIsValidForStreaming(req.params.id)
            const isStreamingRequested = req.body.streaming === 'true' || req.body.streaming === true
            if (streamable?.isStreaming && isStreamingRequested) {
                const sseStreamer = getRunningExpressApp().sseStreamer

                let chatId = req.body.chatId
                if (!req.body.chatId) {
                    chatId = req.body.chatId ?? req.body.overrideConfig?.sessionId ?? uuidv4()
                    req.body.chatId = chatId
                }
                try {
                    sseStreamer.addExternalClient(chatId, res)
                    res.setHeader('Content-Type', 'text/event-stream')
                    res.setHeader('Cache-Control', 'no-cache')
                    res.setHeader('Connection', 'keep-alive')
                    res.setHeader('X-Accel-Buffering', 'no') //nginx config: https://serverfault.com/a/801629
                    res.flushHeaders()

                    if (process.env.MODE === MODE.QUEUE) {
                        getRunningExpressApp().redisSubscriber.subscribe(chatId)
                    }

                    // 2. Wrap the core prediction logic in a timeout
                    const apiResponse = await withTimeout(
                        predictionsServices.buildChatflow(req),
                        60000 // 60s timeout
                    )
                    sseStreamer.streamMetadataEvent(apiResponse.chatId, apiResponse)
                } catch (error) {
                    console.error('[Prediction Error]:', error);
                    if (chatId) {
                        sseStreamer.streamErrorEvent(chatId, getErrorMessage(error))
                    }
                    // 4. Return a proper error to the client so the UI stops loading
                    return res.status(500).json({
                        success: false,
                        message: getErrorMessage(error),
                        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
                    });
                } finally {
                    sseStreamer.removeClient(chatId)
                }
            } else {
                try {
                    // 2. Wrap the core prediction logic in a timeout
                    const apiResponse = await withTimeout(
                        predictionsServices.buildChatflow(req),
                        60000 // 60s timeout
                    )
                    // 3. Ensure we actually send a response
                    return res.json(apiResponse)
                } catch (error) {
                    console.error('[Prediction Error]:', error);
                    // 4. Return a proper error to the client so the UI stops loading
                    return res.status(500).json({
                        success: false,
                        message: getErrorMessage(error),
                        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
                    });
                }
            }
        } else {
            const isStreamingRequested = req.body.streaming === 'true' || req.body.streaming === true
            if (isStreamingRequested) {
                return res.status(StatusCodes.FORBIDDEN).send(unauthorizedOriginError)
            }
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, unauthorizedOriginError)
        }
    } catch (error) {
        console.error('[Prediction Error]:', error);
        // 4. Return a proper error to the client so the UI stops loading
        return res.status(500).json({
            success: false,
            message: getErrorMessage(error),
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}

const getRateLimiterMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        return RateLimiterManager.getInstance().getRateLimiter()(req, res, next)
    } catch (error) {
        next(error)
    }
}

export default {
    createPrediction,
    getRateLimiterMiddleware
}
