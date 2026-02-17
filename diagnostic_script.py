import requests
import json
import time

# Replace with your local or cloud URL
BASE_URL = "http://localhost:3000" 
CHATFLOW_ID = "YOUR_CHATFLOW_ID"

url = f"{BASE_URL}/api/v1/prediction/{CHATFLOW_ID}"

payload = {
    "question": "Test message to debug hanging",
    "history": []
}

print(f" sending request to {url}...")
start_time = time.time()

try:
    # Set a strict timeout to catch the hang
    response = requests.post(url, json=payload, timeout=30) 
    
    print(f"Status Code: {response.status_code}")
    print(f"Response: {response.text[:200]}...") # Print first 200 chars
    print(f"Time Taken: {round(time.time() - start_time, 2)}s")

except requests.exceptions.Timeout:
    print("❌ Error: Request timed out. The server received the request but is stuck.")
except Exception as e:
    print(f"❌ Error: {e}")
