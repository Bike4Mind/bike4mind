---
title: Functions over MCP
description: Connect an MCP client to your live functions, list them with their input and output schemas, and call them with structured results.
sidebar_position: 8
---

# Functions over MCP

The same live functions you call through the [Functions API](./functions.md) are also served as tools to any MCP client. The endpoint is `POST /api/mcp/functions` on your deployment; the hosted URL is `https://app.bike4mind.com/api/mcp/functions`. It speaks the MCP streamable HTTP transport and answers with JSON.

## Before you connect

- An organization admin turns on **Enable Callable Functions over MCP**. It needs **Enable Callable Functions**, is off by default, and must be on for every organization you belong to.
- You create a key with the **Functions** access level, as described in [Create a Functions key](./functions.md#create-a-functions-key). The key holds `functions:invoke` and nothing else.

Your key is the approval: a call made with your own key runs your live function without asking.

## Configure a client

Point the client at the URL and send the key as a bearer token. A typical configuration:

```json
{
  "mcpServers": {
    "functions": {
      "type": "http",
      "url": "https://app.bike4mind.com/api/mcp/functions",
      "headers": { "Authorization": "Bearer <your-api-key>" }
    }
  }
}
```

The endpoint keeps no session. It issues no session id and ignores one sent to it, and every request checks the key, its scope, and the setting again.

## List tools

`tools/list` returns one tool per live function. The tool name is the function's slug. `inputSchema` and `outputSchema` are the function's input and output JSON Schemas, with each field's `unit` kept as an extra keyword. Every tool carries `annotations.readOnlyHint: true` and `_meta.trust_label`, one of `platform` (Platform: curated and checked by Bike4Mind), `verified`, or `unverified`, as described in [Trust labels](./functions.md#trust-labels).

## Call a tool

`tools/call` with the tool name and its arguments runs the function and returns:

- `structuredContent`: the output alone, which matches the tool's `outputSchema`.
- `content`: one text block holding `{ "output": ..., "stamp": ... }`.
- `_meta.stamp`: the stamp, the same one the Functions API returns, with `surface` set to `mcp`.

```json
{
  "structuredContent": { "deflection": 0.0081 },
  "content": [{ "type": "text", "text": "{\"output\":{\"deflection\":0.0081},\"stamp\":{...}}" }],
  "_meta": { "stamp": { "slug": "beam_midspan_deflection", "pin_version": 5, "surface": "mcp" } }
}
```

The limits are 5 MB in, 2 MB out, 45 seconds per call, and the same per-user rate limit as the Functions API. The output goes back twice, once as `structuredContent` and once in the text block, so the limit applies to the answer as sent, escaping included. An output over 2 MB, or one whose answer would pass 5 MB (text made mostly of quote characters grows the most), returns `The function returned more than a call can carry.` instead.

## Refusals

A request the endpoint refuses before reading any MCP message gets an HTTP error with the shared [error envelope](./errors.md). MCP clients show the body:

- `403` with `required_scopes`: the key does not hold `functions:invoke`.
- `403`: the request carries no API key, or callable functions over MCP are turned off for your account.
- `400`: the body is a JSON-RPC batch. Send one message per request.
- `429`: you passed the rate limit.

A call that cannot run returns a result with `isError: true` and the reason in its text block:

- `Function not found`: the name is not one of your live functions. A draft, a turned-off function, and another person's function answer the same way.
- `Input span must be a number.`: an input does not fit `inputSchema`; the text names the first field.
- The function raised an error, ran out of memory, or returned outputs that do not fit `outputSchema`. When the function ran, `_meta.stamp` is included.
- `The call ran past its time limit.`: the call passed 45 seconds, counted from the request's arrival, or too little of them was left to start it.
- `The function runtime did not answer. Try again later.`: the function runtime failed or never replied. No stamp is included.
- `Internal error`: the endpoint could not read your functions. `tools/list` answers the same text as a JSON-RPC error.
