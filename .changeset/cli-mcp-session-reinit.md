---
"@bike4mind/cli": patch
---

Recover the tools of a streamable-HTTP MCP server after it expires an idle session: the CLI bundles @bike4mind/mcp, whose client now starts a new session on a 404 and retries the call once.
