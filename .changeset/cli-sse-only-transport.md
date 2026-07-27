---
"@bike4mind/cli": minor
---

use SSE-only transport for LLM completions

Completions no longer attempt the WebSocket transport, which fixed the indefinite
"thinking" hang on stacks whose realtime relay emits `streamed_chat_completion`
instead of the CLI's chunk protocol. Two WebSocket-only capabilities go with it:
the Keep command relay (web HUD executing commands on the local machine) and
WebSocket-based server-side tool execution (tools now run CLI-side). Feature
modules that consume realtime events (Tavern's activity stream) keep their socket.
