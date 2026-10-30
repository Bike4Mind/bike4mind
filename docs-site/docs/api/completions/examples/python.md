---
title: Python Examples
description: Production-ready Python code examples for the B4M Completions API
sidebar_position: 2
---

# Python Examples

Production-ready Python code examples for integrating the B4M Completions API. The first two sections define the stream loop, the error type and the retry helper once. Every later sample imports them and shows only what it adds.

## Installation

```bash
pip install requests sseclient-py
```

The async example also needs `pip install aiohttp`.

---

## Basic Streaming Example

Save this as `b4m_stream.py`. It is the one stream loop and the one error type that the other samples reuse:

```python
import json
import time
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Dict, Optional

import requests
from sseclient import SSEClient

BASE_URL = "https://app.bike4mind.com"


class CompletionError(Exception):
    """A failed request: HTTP status, in-band error code, request id, Retry-After seconds."""

    def __init__(self, message, status=None, code=None, request_id=None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id
        self.retry_after = retry_after


def retry_after_seconds(value: Optional[str]) -> Optional[float]:
    if not value or not value.strip():
        return None
    if value.strip().isdigit():
        return int(value)
    try:
        return max(0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def http_error(status: int, text: str, retry_after: Optional[str]) -> CompletionError:
    try:
        body = json.loads(text)
    except ValueError:
        body = None
    if not isinstance(body, dict):
        body = {}
    return CompletionError(
        body.get("error") or text,
        status=status,
        code=body.get("errorCode"),
        request_id=body.get("request_id"),
        retry_after=retry_after_seconds(retry_after),
    )


def parse_event(data: str, status: int) -> Dict[str, Any]:
    """Parse one SSE data payload; raise CompletionError for a malformed or in-band error event."""
    try:
        event = json.loads(data)
    except json.JSONDecodeError as e:
        raise CompletionError(f"Malformed stream event: {data!r}") from e

    # The HTTP status is already 200, so a failure arrives as an event
    if event.get("type") == "error":
        raise CompletionError(
            event["message"],
            status=status,
            code=event.get("code"),
            request_id=event.get("requestId"),
        )
    return event


INCOMPLETE_STOP_REASONS = {"max_tokens", "degenerate_repetition", "refusal", "pause_turn"}


def assert_complete_stop_reason(stop_reason, request_id):
    # Older servers and some providers omit this field; absence alone is not failure.
    if stop_reason not in INCOMPLETE_STOP_REASONS:
        return
    message = (
        "Reply truncated: max_tokens reached"
        if stop_reason == "max_tokens"
        else f"Reply did not finish: {stop_reason}"
    )
    raise CompletionError(message, code=stop_reason, request_id=request_id)


def stream_completion(
    api_key: str,
    payload: Dict[str, Any],
    on_event: Callable[[Dict[str, Any]], None],
    base_url: str = BASE_URL,
    session: Optional[requests.Session] = None,
) -> None:
    """
    Stream a completion and call on_event for every event before [DONE].

    Raises:
        CompletionError: On an HTTP error, an in-band error event, a malformed
            event, a known incomplete stop reason, or a stream that ends without [DONE]
    """
    with (session or requests).post(
        f"{base_url}/api/ai/v1/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        stream=True,
    ) as response:
        if not response.ok:
            raise http_error(response.status_code, response.text, response.headers.get("Retry-After"))

        stop_reason = None
        request_id = None
        for sse in SSEClient(response).events():
            if sse.data == "[DONE]":
                assert_complete_stop_reason(stop_reason, request_id)
                return
            event = parse_event(sse.data, response.status_code)
            request_id = event.get("requestId") or request_id
            stop_reason = event.get("stopReason") or stop_reason
            on_event(event)

        raise CompletionError("Stream ended without [DONE] or an error event")
```

Use it:

```python
import os

from b4m_stream import stream_completion


def print_text(event):
    if event["type"] == "content":
        print(event["text"], end="", flush=True)


stream_completion(
    os.environ["B4M_API_KEY"],
    {"model": "claude-sonnet-5", "messages": [{"role": "user", "content": "Write a haiku about Python"}]},
    print_text,
)
```

---

## Retry Helper

Add this to `b4m_stream.py`. It is the one retry policy; see the [retry table](../errors.md) for which failures are worth retrying:

```python
def retry_delay(error: CompletionError, attempt: int, max_attempts: int) -> Optional[float]:
    """Seconds to wait before the next attempt, or None if the error should be raised."""
    # Retry only 429, 500, 503 and in-band provider_error
    retryable = error.status in (429, 500, 503) or error.code == "provider_error"
    if not retryable or attempt >= max_attempts - 1:
        return None
    # Honor Retry-After when present; otherwise back off 1s, 2s, 4s
    return error.retry_after if error.retry_after is not None else 2 ** attempt


def with_retry(fn: Callable[[], Any], max_attempts: int = 3) -> Any:
    for attempt in range(max_attempts):
        try:
            return fn()
        except CompletionError as e:
            delay = retry_delay(e, attempt, max_attempts)
            if delay is None:
                raise
            time.sleep(delay)
```

```python
def attempt():
    parts = []
    stream_completion(
        api_key, payload, lambda event: parts.append(event["text"]) if event["type"] == "content" else None
    )
    return "".join(parts)


print(with_retry(attempt))
```

A retry restarts the stream from the beginning. Reset accumulators inside `fn` on every attempt, and publish buffered output only after success. Do not automatically retry a callback that executes tools or performs other side effects.

---

## Client Class

A session-reusing wrapper over `stream_completion`. Its `complete()` method returns the full text and retries the whole request on a transient failure:

```python
import os
from typing import Any, Callable, Dict, List, Optional

import requests

from b4m_stream import BASE_URL, stream_completion, with_retry


class B4MCompletionClient:
    def __init__(self, api_key: str, base_url: str = BASE_URL, max_retries: int = 3):
        if not api_key:
            raise ValueError("API key is required")
        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries
        self.session = requests.Session()

    def stream_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        options: Optional[Dict[str, Any]] = None,
        on_event: Callable[[Dict], None] = lambda event: None,
    ) -> None:
        """options (temperature, max_tokens, tools, ...) are merged into the request body."""
        payload = {"model": model, "messages": messages, **(options or {})}
        stream_completion(self.api_key, payload, on_event, self.base_url, self.session)

    def complete(self, model: str, messages: List[Dict[str, Any]], options: Optional[Dict[str, Any]] = None) -> str:
        def attempt() -> str:
            parts: List[str] = []
            self.stream_completion(
                model, messages, options, lambda e: parts.append(e["text"]) if e["type"] == "content" else None
            )
            return "".join(parts)

        return with_retry(attempt, self.max_retries)

    def close(self) -> None:
        self.session.close()


if __name__ == "__main__":
    client = B4MCompletionClient(os.environ["B4M_API_KEY"])
    try:
        print(client.complete("claude-sonnet-5", [{"role": "user", "content": "What is 2+2?"}]))
    finally:
        client.close()
```

---

## Tool Calling Example

Complete tool calling loop. B4M returns each tool call with an `id` and `arguments` as a JSON string:

```python
import json
import os
from typing import Any, Dict

from b4m_stream import stream_completion

TOOLS = [
    {
        "toolSchema": {
            "name": "get_weather",
            "description": "Get current weather for a location",
            "parameters": {
                "type": "object",
                "properties": {"location": {"type": "string", "description": "City name"}},
                "required": ["location"],
            },
        }
    }
]


def execute_tool(name: str, input_data: Dict[str, Any]) -> Dict[str, Any]:
    if name == "get_weather":
        # Mock weather API call
        return {"location": input_data["location"], "temperature": 72, "condition": "Sunny"}
    raise ValueError(f"Unknown tool: {name}")


def completion_with_tools(api_key: str, user_query: str) -> str:
    messages = [{"role": "user", "content": user_query}]

    while True:
        tool_calls = []
        response_text = ""
        thinking = []

        def handle_event(event):
            nonlocal tool_calls, response_text, thinking
            if event["type"] in ("content", "tool_use"):
                response_text += event["text"]
            if event["type"] == "tool_use":
                tool_calls = event.get("tools", [])
            if event.get("thinking"):
                thinking = event["thinking"]

        stream_completion(
            api_key, {"model": "claude-sonnet-5", "messages": messages, "tools": TOOLS}, handle_event
        )

        if not tool_calls:
            return response_text

        calls = [(t, json.loads(t.get("arguments") or "{}")) for t in tool_calls]

        messages.append({
            "role": "assistant",
            "content": [
                *thinking,  # Replay signed thinking/redacted_thinking blocks unchanged
                *([{"type": "text", "text": response_text}] if response_text else []),
                *[{"type": "tool_use", "id": t["id"], "name": t["name"], "input": args} for t, args in calls],
            ],
        })
        messages.append({
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": t["id"], "content": json.dumps(execute_tool(t["name"], args))}
                for t, args in calls
            ],
        })


print(completion_with_tools(os.environ["B4M_API_KEY"], "What is the weather in San Francisco?"))
```

---

## Async Implementation

An aiohttp client for concurrent requests. It reuses `CompletionError`, `http_error`, `parse_event` and `retry_delay` from `b4m_stream.py`, and keeps one `ClientSession` for its lifetime:

```python
import asyncio
import codecs
import os
from typing import Any, Callable, Dict, List, Optional

import aiohttp

from b4m_stream import BASE_URL, CompletionError, assert_complete_stop_reason, http_error, parse_event, retry_delay


class AsyncB4MCompletionClient:
    def __init__(self, api_key: str, base_url: str = BASE_URL, max_retries: int = 3):
        if not api_key:
            raise ValueError("API key is required")
        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries
        self._session: Optional[aiohttp.ClientSession] = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info) -> None:
        await self.close()

    async def close(self) -> None:
        if self._session:
            await self._session.close()

    async def stream_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        options: Optional[Dict[str, Any]] = None,
        on_event: Callable[[Dict], None] = lambda event: None,
    ) -> None:
        if self._session is None:
            self._session = aiohttp.ClientSession()

        payload = {"model": model, "messages": messages, **(options or {})}
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        async with self._session.post(f"{self.base_url}/api/ai/v1/completions", headers=headers, json=payload) as response:
            if not response.ok:
                raise http_error(response.status, await response.text(), response.headers.get("Retry-After"))

            # An incremental decoder keeps a multibyte character that is split across chunks intact
            decoder = codecs.getincrementaldecoder("utf-8")()
            buffer = ""
            stop_reason = None
            request_id = None

            async for chunk in response.content.iter_any():
                buffer += decoder.decode(chunk)
                *events, buffer = buffer.split("\n\n")

                for raw_event in events:
                    for line in raw_event.splitlines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:].strip()
                        if data == "[DONE]":
                            assert_complete_stop_reason(stop_reason, request_id)
                            return
                        event = parse_event(data, response.status)
                        request_id = event.get("requestId") or request_id
                        stop_reason = event.get("stopReason") or stop_reason
                        on_event(event)

        raise CompletionError("Stream ended without [DONE] or an error event")

    async def complete(self, model: str, messages: List[Dict[str, Any]], options: Optional[Dict[str, Any]] = None) -> str:
        for attempt in range(self.max_retries):
            parts: List[str] = []
            try:
                await self.stream_completion(
                    model, messages, options, lambda e: parts.append(e["text"]) if e["type"] == "content" else None
                )
                return "".join(parts)
            except CompletionError as e:
                delay = retry_delay(e, attempt, self.max_retries)
                if delay is None:
                    raise
                await asyncio.sleep(delay)


async def main():
    async with AsyncB4MCompletionClient(os.environ["B4M_API_KEY"]) as client:
        results = await asyncio.gather(*[
            client.complete("claude-sonnet-5", [{"role": "user", "content": f"Count to {i}"}])
            for i in range(1, 4)
        ])
        for i, result in enumerate(results, 1):
            print(f"\nResult {i}: {result}")


if __name__ == "__main__":
    asyncio.run(main())
```

---

## Rate Limiting

Client-side sliding-window limiter. Set the limit to your own plan's limit, listed in the [in-app API reference](https://app.bike4mind.com/api/v1/docs):

```python
import time
from collections import deque
from typing import Deque


class RateLimiter:
    def __init__(self, requests_per_minute: int):
        if not isinstance(requests_per_minute, int) or requests_per_minute < 1:
            raise ValueError("requests_per_minute must be a positive integer")
        self.requests_per_minute = requests_per_minute
        self.requests: Deque[float] = deque()

    def wait_for_slot(self) -> None:
        while True:
            now = time.time()
            while self.requests and self.requests[0] < now - 60:
                self.requests.popleft()

            if len(self.requests) < self.requests_per_minute:
                self.requests.append(now)
                return
            time.sleep(max(60 - (now - self.requests[0]), 0.01))
```

---

## Production Example

Combine the pieces: the limiter in front of the client class, plus logging. Each retry waits for a limiter slot again:

```python
import logging
import os

from b4m_stream import CompletionError

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


class ProductionB4MClient(B4MCompletionClient):
    def __init__(self, api_key: str, requests_per_minute: int, **kwargs):
        super().__init__(api_key, **kwargs)
        self.rate_limiter = RateLimiter(requests_per_minute)

    def stream_completion(self, model, messages, options=None, on_event=lambda event: None) -> None:
        self.rate_limiter.wait_for_slot()

        def log_usage(event):
            if event.get("usage"):
                logger.info("Tokens: %s", event["usage"])
            on_event(event)

        try:
            super().stream_completion(model, messages, options, log_usage)
        except CompletionError as e:
            logger.error("Error: %s (status=%s, code=%s, request_id=%s)", e, e.status, e.code, e.request_id)
            raise


if __name__ == "__main__":
    client = ProductionB4MClient(
        os.environ["B4M_API_KEY"], requests_per_minute=int(os.environ["B4M_REQUESTS_PER_MINUTE"])
    )
    try:
        print(client.complete("claude-sonnet-5", [{"role": "user", "content": "Hello!"}]))
    finally:
        client.close()
```

---

## Next Steps

- **[JavaScript Examples](./javascript.md)** - See JavaScript implementations
- **[curl Examples](./curl.md)** - Quick testing
- **[Best Practices](../best-practices.md)** - Production patterns
- **[Error Handling](../errors.md)** - Handle errors properly
