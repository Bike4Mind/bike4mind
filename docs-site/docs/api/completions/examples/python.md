---
title: Python Examples
description: Production-ready Python code examples for the B4M Completions API
sidebar_position: 2
---

# Python Examples

Production-ready Python code examples for integrating the B4M Completions API.

## Installation

Install required dependencies:

```bash
pip install requests sseclient-py
```

---

## Basic Streaming Example

Simple streaming implementation using requests and sseclient-py:

```python
import json
import os
import requests
from sseclient import SSEClient

def stream_completion(api_key: str, messages: list, model: str = "claude-3-5-sonnet"):
    """
    Stream a completion from the B4M API.

    Args:
        api_key: B4M API key
        messages: List of message dicts with 'role' and 'content'
        model: Model identifier (default: claude-3-5-sonnet)
    """
    url = "https://app.bike4mind.com/api/ai/v1/completions"
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages
    }

    response = requests.post(url, headers=headers, json=payload, stream=True)
    response.raise_for_status()

    client = SSEClient(response)

    for event in client.events():
        if event.data == "[DONE]":
            print("\n✓ Stream complete")
            break

        try:
            data = json.loads(event.data)

            if data["type"] == "content":
                print(data["text"], end="", flush=True)
            elif data["type"] == "error":
                raise Exception(f"Stream error: {data['message']}")

        except json.JSONDecodeError as e:
            print(f"\nJSON parse error: {e}")

# Usage
if __name__ == "__main__":
    api_key = os.environ.get("B4M_API_KEY")
    if not api_key:
        raise ValueError("B4M_API_KEY environment variable not set")

    messages = [
        {"role": "user", "content": "Write a haiku about Python"}
    ]

    stream_completion(api_key, messages)
```

---

## Complete Client Class

Production-ready client class with full features:

```python
import json
import os
from typing import List, Dict, Optional, Callable, Any
import requests
from sseclient import SSEClient

class B4MCompletionClient:
    """Client for B4M AI Completions API"""

    def __init__(self, api_key: str, base_url: str = "https://app.bike4mind.com"):
        if not api_key:
            raise ValueError("API key is required")

        self.api_key = api_key
        self.base_url = base_url
        self.session = requests.Session()

    def stream_completion(
        self,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]] = None,
        on_event: Optional[Callable[[Dict], None]] = None
    ) -> None:
        """
        Stream a completion with optional event callback.

        Args:
            model: Model identifier
            messages: List of message dicts
            options: Optional completion options (temperature, maxTokens, etc.)
            on_event: Optional callback for each SSE event

        Raises:
            requests.HTTPError: If request fails
            Exception: If stream error occurs
        """
        url = f"{self.base_url}/api/ai/v1/completions"
        headers = {
            "X-API-Key": self.api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": messages
        }
        if options:
            payload["options"] = options

        response = self.session.post(url, headers=headers, json=payload, stream=True)

        try:
            response.raise_for_status()
        except requests.HTTPError as e:
            error_text = response.text
            raise Exception(f"HTTP {response.status_code}: {error_text}") from e

        client = SSEClient(response)

        for event in client.events():
            if event.data == "[DONE]":
                break

            try:
                data = json.loads(event.data)

                if data["type"] == "error":
                    raise Exception(f"Stream error: {data['message']}")

                if on_event:
                    on_event(data)

            except json.JSONDecodeError as e:
                print(f"JSON parse error: {e}, Raw data: {event.data}")

    def complete(
        self,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Get a complete response (waits for entire stream).

        Args:
            model: Model identifier
            messages: List of message dicts
            options: Optional completion options

        Returns:
            Complete response text
        """
        full_response = []

        def collect_text(event: Dict):
            if event["type"] == "content":
                full_response.append(event["text"])

        self.stream_completion(model, messages, options, on_event=collect_text)

        return "".join(full_response)

    def close(self):
        """Close the HTTP session"""
        self.session.close()

# Usage
if __name__ == "__main__":
    api_key = os.environ.get("B4M_API_KEY")
    client = B4MCompletionClient(api_key)

    try:
        # Streaming with callback
        print("Streaming response:")
        client.stream_completion(
            model="claude-3-5-sonnet",
            messages=[{"role": "user", "content": "Hello!"}],
            options={"temperature": 0.7, "maxTokens": 1024},
            on_event=lambda event: print(event["text"], end="", flush=True) if event["type"] == "content" else None
        )
        print("\n")

        # Non-streaming (wait for complete response)
        print("Complete response:")
        response = client.complete(
            model="claude-3-5-sonnet",
            messages=[{"role": "user", "content": "What is 2+2?"}]
        )
        print(response)

    finally:
        client.close()
```

---

## Error Handling with Retry Logic

Client with automatic retry on transient errors:

```python
import time
from typing import Optional

class B4MCompletionClientWithRetry(B4MCompletionClient):
    """Client with automatic retry logic"""

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://app.bike4mind.com",
        max_retries: int = 3
    ):
        super().__init__(api_key, base_url)
        self.max_retries = max_retries

    def stream_completion_with_retry(
        self,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]] = None,
        on_event: Optional[Callable[[Dict], None]] = None
    ) -> None:
        """Stream completion with automatic retry on transient errors"""

        for attempt in range(self.max_retries):
            try:
                return self.stream_completion(model, messages, options, on_event)

            except requests.HTTPError as e:
                status_code = e.response.status_code

                # Rate limited - wait and retry
                if status_code == 429:
                    retry_after = int(e.response.headers.get("Retry-After", 60))
                    print(f"\nRate limited. Waiting {retry_after}s before retry...")
                    time.sleep(retry_after)
                    continue

                # Server error - exponential backoff
                if status_code >= 500:
                    if attempt < self.max_retries - 1:
                        delay = 2 ** attempt  # 1s, 2s, 4s
                        print(f"\nServer error. Retrying in {delay}s...")
                        time.sleep(delay)
                        continue

                # Other errors - don't retry
                raise

            except Exception as e:
                if attempt == self.max_retries - 1:
                    raise
                print(f"\nError: {e}. Retrying...")
                time.sleep(1)

        raise Exception(f"Failed after {self.max_retries} attempts")

# Usage
client = B4MCompletionClientWithRetry(os.environ.get("B4M_API_KEY"), max_retries=3)

try:
    client.stream_completion_with_retry(
        model="claude-3-5-sonnet",
        messages=[{"role": "user", "content": "Hello!"}],
        on_event=lambda event: print(event["text"], end="") if event["type"] == "content" else None
    )
finally:
    client.close()
```

---

## Tool Calling Example

Complete tool calling implementation:

```python
from typing import List, Dict, Any

def completion_with_tools(
    client: B4MCompletionClient,
    user_query: str
) -> str:
    """
    Complete a request with tool calling support.

    Args:
        client: B4MCompletionClient instance
        user_query: User's question

    Returns:
        Final response text
    """
    tools = [
        {
            "toolSchema": {
                "name": "get_weather",
                "description": "Get current weather for a location",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {
                            "type": "string",
                            "description": "City name (e.g., 'San Francisco')"
                        }
                    },
                    "required": ["location"]
                }
            }
        }
    ]

    messages = [
        {"role": "user", "content": user_query}
    ]

    while True:
        tool_calls = []
        response_text = ""

        # Stream completion
        def handle_event(event):
            nonlocal tool_calls, response_text

            if event["type"] == "content":
                response_text += event["text"]
            elif event["type"] == "tool_use":
                response_text += event["text"]
                tool_calls = event.get("tools", [])

        client.stream_completion(
            model="claude-3-5-sonnet",
            messages=messages,
            options={"tools": tools},
            on_event=handle_event
        )

        # No tool calls - we're done
        if not tool_calls:
            return response_text

        # Execute tools
        # Note: B4M returns tools with 'arguments' (JSON string) and 'id'
        # Parse arguments to get input object
        print(f"\nExecuting tools: {tool_calls}")

        # Add assistant message with tool calls
        messages.append({
            "role": "assistant",
            "content": [
                {"type": "text", "text": response_text},
                *[
                    {
                        "type": "tool_use",
                        "id": tool["id"],  # Use actual ID from B4M response
                        "name": tool["name"],
                        # Parse arguments from JSON string if needed
                        "input": json.loads(tool["arguments"]) if isinstance(tool.get("arguments"), str) else tool.get("input", {})
                    }
                    for tool in tool_calls
                ]
            ]
        })

        # Execute tools and add results
        tool_results = []
        for tool in tool_calls:
            # Parse arguments from JSON string if needed
            tool_input = json.loads(tool["arguments"]) if isinstance(tool.get("arguments"), str) else tool.get("input", {})
            result = execute_tool(tool["name"], tool_input)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tool["id"],  # Use actual ID from B4M response
                "content": json.dumps(result)
            })

        messages.append({
            "role": "user",
            "content": tool_results
        })

        # Continue loop for final response

def execute_tool(name: str, input_data: Dict) -> Dict:
    """Execute a tool and return its result"""
    if name == "get_weather":
        # Mock weather API call
        return {
            "location": input_data["location"],
            "temperature": 72,
            "condition": "Sunny",
            "humidity": 45
        }
    else:
        raise ValueError(f"Unknown tool: {name}")

# Usage
client = B4MCompletionClient(os.environ.get("B4M_API_KEY"))

try:
    result = completion_with_tools(
        client,
        "What is the weather in San Francisco?"
    )
    print(result)
finally:
    client.close()
```

---

## Async Implementation

Async client using aiohttp for concurrent requests:

```python
import asyncio
import aiohttp
import json
from typing import List, Dict, Optional, Callable, Any

class AsyncB4MCompletionClient:
    """Async client for B4M AI Completions API"""

    def __init__(self, api_key: str, base_url: str = "https://app.bike4mind.com"):
        if not api_key:
            raise ValueError("API key is required")

        self.api_key = api_key
        self.base_url = base_url

    async def stream_completion(
        self,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]] = None,
        on_event: Optional[Callable[[Dict], None]] = None
    ) -> None:
        """
        Stream a completion asynchronously.

        Args:
            model: Model identifier
            messages: List of message dicts
            options: Optional completion options
            on_event: Optional callback for each SSE event
        """
        url = f"{self.base_url}/api/ai/v1/completions"
        headers = {
            "X-API-Key": self.api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": messages
        }
        if options:
            payload["options"] = options

        async with aiohttp.ClientSession() as session:
            async with session.post(url, headers=headers, json=payload) as response:
                if not response.ok:
                    error_text = await response.text()
                    raise Exception(f"HTTP {response.status}: {error_text}")

                buffer = ""

                async for chunk in response.content:
                    buffer += chunk.decode('utf-8')

                    lines = buffer.split('\n\n')
                    buffer = lines.pop() if lines else ""

                    for message in lines:
                        if message.startswith('data: '):
                            data = message[6:].strip()

                            if data == "[DONE]":
                                return

                            try:
                                event = json.loads(data)

                                if event["type"] == "error":
                                    raise Exception(f"Stream error: {event['message']}")

                                if on_event:
                                    on_event(event)

                            except json.JSONDecodeError as e:
                                print(f"Parse error: {e}")

    async def complete(
        self,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Get a complete response asynchronously.

        Args:
            model: Model identifier
            messages: List of message dicts
            options: Optional completion options

        Returns:
            Complete response text
        """
        full_response = []

        def collect_text(event: Dict):
            if event["type"] == "content":
                full_response.append(event["text"])

        await self.stream_completion(model, messages, options, on_event=collect_text)

        return "".join(full_response)

# Usage
async def main():
    api_key = os.environ.get("B4M_API_KEY")
    client = AsyncB4MCompletionClient(api_key)

    # Single request
    response = await client.complete(
        model="claude-3-5-sonnet",
        messages=[{"role": "user", "content": "Hello!"}]
    )
    print(response)

    # Concurrent requests
    tasks = [
        client.complete(
            model="claude-3-5-sonnet",
            messages=[{"role": "user", "content": f"Count to {i}"}]
        )
        for i in range(1, 4)
    ]

    results = await asyncio.gather(*tasks)
    for i, result in enumerate(results, 1):
        print(f"\nResult {i}: {result}")

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Rate Limiting

Client-side rate limiting implementation:

```python
import time
from collections import deque
from typing import Deque

class RateLimiter:
    """Simple rate limiter using sliding window"""

    def __init__(self, requests_per_minute: int):
        self.requests_per_minute = requests_per_minute
        self.requests: Deque[float] = deque()

    def wait_for_slot(self) -> None:
        """Wait until a rate limit slot is available"""
        now = time.time()
        one_minute_ago = now - 60

        # Remove old requests
        while self.requests and self.requests[0] < one_minute_ago:
            self.requests.popleft()

        if len(self.requests) >= self.requests_per_minute:
            # Wait until oldest request expires
            oldest = self.requests[0]
            wait_time = 60 - (now - oldest)

            if wait_time > 0:
                print(f"Rate limit: waiting {wait_time:.1f}s")
                time.sleep(wait_time)

            # Recursive call to check again
            return self.wait_for_slot()

        self.requests.append(now)

# Usage with client
limiter = RateLimiter(60)  # 60 requests per minute
client = B4MCompletionClient(os.environ.get("B4M_API_KEY"))

def make_rate_limited_request(messages: List[Dict]) -> str:
    limiter.wait_for_slot()
    return client.complete("claude-3-5-sonnet", messages)

try:
    # Make multiple requests with automatic rate limiting
    for i in range(100):
        response = make_rate_limited_request([
            {"role": "user", "content": f"Request {i}"}
        ])
        print(f"Response {i}: {response[:50]}...")
finally:
    client.close()
```

---

## Complete Production Example

Full production-ready implementation with all features:

```python
import json
import os
import time
import logging
from typing import List, Dict, Optional, Callable, Any
from collections import deque
import requests
from sseclient import SSEClient

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class ProductionB4MClient:
    """Production-ready B4M Completions client"""

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://app.bike4mind.com",
        max_retries: int = 3,
        requests_per_minute: int = 60
    ):
        if not api_key:
            raise ValueError("API key is required")

        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries
        self.session = requests.Session()
        self.rate_limiter = RateLimiter(requests_per_minute)

        logger.info(f"Initialized client (max_retries={max_retries}, rpm={requests_per_minute})")

    def complete(
        self,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]] = None,
        on_chunk: Optional[Callable[[str], None]] = None
    ) -> str:
        """
        Complete a request with full production features.

        Args:
            model: Model identifier
            messages: List of message dicts
            options: Optional completion options
            on_chunk: Optional callback for each text chunk

        Returns:
            Complete response text
        """
        # Wait for rate limit slot
        self.rate_limiter.wait_for_slot()

        # Retry logic
        for attempt in range(self.max_retries):
            try:
                logger.info(f"Attempt {attempt + 1}/{self.max_retries}")

                full_response = ""

                def handle_event(event: Dict):
                    nonlocal full_response

                    if event["type"] == "content":
                        full_response += event["text"]

                        if on_chunk:
                            on_chunk(event["text"])

                        if event.get("usage"):
                            logger.info(f"Tokens: {event['usage']}")

                self._stream_completion(model, messages, options, handle_event)

                logger.info("Completion succeeded")
                return full_response

            except requests.HTTPError as e:
                logger.error(f"HTTP error: {e}")

                # Rate limited
                if e.response.status_code == 429:
                    retry_after = int(e.response.headers.get("Retry-After", 60))
                    logger.warning(f"Rate limited. Waiting {retry_after}s...")
                    time.sleep(retry_after)
                    continue

                # Server error
                if e.response.status_code >= 500 and attempt < self.max_retries - 1:
                    delay = 2 ** attempt
                    logger.warning(f"Server error. Retrying in {delay}s...")
                    time.sleep(delay)
                    continue

                # Non-retryable error
                raise

            except Exception as e:
                logger.error(f"Error: {e}")

                if attempt == self.max_retries - 1:
                    raise

                time.sleep(1)

        raise Exception(f"Failed after {self.max_retries} attempts")

    def _stream_completion(
        self,
        model: str,
        messages: List[Dict[str, str]],
        options: Optional[Dict[str, Any]],
        on_event: Callable[[Dict], None]
    ) -> None:
        """Internal method to stream completion"""
        url = f"{self.base_url}/api/ai/v1/completions"
        headers = {
            "X-API-Key": self.api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": messages
        }
        if options:
            payload["options"] = options

        response = self.session.post(url, headers=headers, json=payload, stream=True)
        response.raise_for_status()

        client = SSEClient(response)

        for event in client.events():
            if event.data == "[DONE]":
                break

            try:
                data = json.loads(event.data)

                if data["type"] == "error":
                    raise Exception(f"Stream error: {data['message']}")

                on_event(data)

            except json.JSONDecodeError as e:
                logger.error(f"Parse error: {e}")

    def close(self):
        """Close the HTTP session"""
        self.session.close()
        logger.info("Client closed")

# Usage
if __name__ == "__main__":
    client = ProductionB4MClient(
        api_key=os.environ.get("B4M_API_KEY"),
        max_retries=3,
        requests_per_minute=60
    )

    try:
        response = client.complete(
            model="claude-3-5-sonnet",
            messages=[{"role": "user", "content": "Hello!"}],
            on_chunk=lambda text: print(text, end="", flush=True)
        )

        print(f"\n\nFull response: {response}")

    finally:
        client.close()
```

---

## Next Steps

- **[JavaScript Examples](/api/completions/examples/javascript)** - See JavaScript implementations
- **[curl Examples](/api/completions/examples/curl)** - Quick testing
- **[Best Practices](/api/completions/best-practices)** - Production patterns
- **[Error Handling](/api/completions/errors)** - Handle errors properly
