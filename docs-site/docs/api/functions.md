---
title: Functions
description: List, read, and call your live functions over the API, and get each result with a stamp of what it ran on.
sidebar_position: 7
---

# Functions

A function is a Python artifact you saved as a function and promoted to live after its tests passed on the server. You list your live functions with `GET /api/v1/functions`, read one with `GET /api/v1/functions/{id}`, and call one with `POST /api/v1/functions/{id}/invoke`. Use your deployment's base URL; the hosted URL is `https://app.bike4mind.com/api/v1`.

## Create a Functions key

In your profile, open the API keys tab, choose **New key**, and pick the **Functions** access level. The key holds the `functions:invoke` scope and nothing else: it reaches only these three routes, and a request to mint `functions:invoke` together with any other scope is refused. The Functions level appears only while callable functions are turned on for your account.

Each call answers for the key's owner. A key reaches only the live functions its owner owns. A draft, a turned-off function, a function whose artifact was deleted, and another person's function all answer `404`, the same as an id that does not exist.

## List your live functions

```bash
curl https://app.bike4mind.com/api/v1/functions \
  -H 'Authorization: Bearer <your-api-key>'
```

The response is `{ "data": [...], "next_cursor": ... }`. Each entry has `id`, `slug`, `description`, `trust_label`, `pin_version`, `pin_seq`, and `updated_at`. Pass `limit` and the previous `next_cursor` as `cursor` to read the next page; `next_cursor` is `null` on the last page.

## Read a function

```bash
curl https://app.bike4mind.com/api/v1/functions/<function-id> \
  -H 'Authorization: Bearer <your-api-key>'
```

The response is `{ "data": { ... } }` with the list fields plus `input_schema` and `output_schema`, the JSON Schemas of the function's inputs and outputs. The pinned code is not returned.

## Call a function

```bash
curl https://app.bike4mind.com/api/v1/functions/<function-id>/invoke \
  -H 'Authorization: Bearer <your-api-key>' \
  -H 'Content-Type: application/json' \
  -d '{"input":{"load":2000,"span":4}}'
```

The body carries the inputs under `input`, shaped by `input_schema`. A successful call answers `200` with `output`, shaped by `output_schema`, and `stamp`:

```json
{
  "output": { "deflection": 0.0081 },
  "stamp": {
    "function_id": "<function-id>",
    "slug": "beam_midspan_deflection",
    "pin_version": 5,
    "pin_seq": 2,
    "code_hash": "<sha256 of the pinned code>",
    "input_hash": "<sha256 of the canonical input>",
    "runtime": { "kind": "pyodide-server", "version": "<runtime version>", "lock_hash": "<sha256>" },
    "packages": [{ "name": "numpy", "version": "<version>" }],
    "data": [],
    "uses": [],
    "trust_label": "verified",
    "surface": "rest",
    "duration_ms": 12,
    "called_at": "2026-01-01T00:00:00.000Z"
  }
}
```

The stamp records which pinned version ran, the hashes of its code and your input, and the runtime and packages it ran on, so you can tell later exactly what produced a result. `input_hash` does not change with key order.

## Limits

- The input may be up to 5 MB, and so may the output.
- A call has 45 seconds to finish. The function itself runs for at most 30 seconds.
- Requests are rate limited per user and per route, at your account's per-minute limit. Each response carries the rate-limit headers.

## Errors

Errors use the shared error envelope described in [Errors](./errors.md).

- `403`: the key does not hold `functions:invoke`, or callable functions are turned off for your account.
- `404`: the function is not one of your live functions.
- `413`: the input is larger than 5 MB.
- `422`: an input does not fit `input_schema`. The `error` names the first field, for example `Input span must be a number.`, and `problems` lists every field with its `path` and `message`.
- `429`: you passed the rate limit.
- `502`: the function raised an error, ran out of memory, or returned outputs that do not fit `output_schema`. `outcome` names which, and `stamp` is included.
- `503`: no function runtime is available.
- `504`: the call ran past its time limit. `errorCode` is `request_timeout`.
