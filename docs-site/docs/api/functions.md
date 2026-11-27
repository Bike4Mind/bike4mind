---
title: Functions
description: List, read, and call your live functions over the API, and get each result with a stamp of what it ran on.
sidebar_position: 7
---

# Functions

A function is a Python artifact you saved as a function and promoted to live after its tests passed on the server. You list your live functions with `GET /api/v1/functions`, read one with `GET /api/v1/functions/{id}`, and call one with `POST /api/v1/functions/{id}/invoke`. Use your deployment's base URL; the hosted URL is `https://app.bike4mind.com/api/v1`.

## Create a Functions key

In your profile, open the API keys tab, choose **New key**, and pick the **Functions** access level. The key holds the `functions:invoke` scope and nothing else: it reaches only these three routes and the [MCP endpoint](./functions-mcp.md), and a request to mint `functions:invoke` together with any other scope is refused. The Functions level appears only while callable functions are turned on for your account.

Each call answers for the key's owner. A key reaches only the live functions its owner owns. A draft, a turned-off function, a function whose artifact was deleted, and another person's function all answer `404`, the same as an id that does not exist.

## List your live functions

```bash
curl https://app.bike4mind.com/api/v1/functions \
  -H 'Authorization: Bearer <your-api-key>'
```

The response is `{ "data": [...], "next_cursor": ... }`. Each entry has `id`, `slug`, `description`, `trust_label`, `pin_version`, `pin_seq`, and `updated_at`. Pass `limit` and the previous `next_cursor` as `cursor` to read the next page; `next_cursor` is `null` on the last page.

### Trust labels

`trust_label` is set on every live function, in the list, in a single read, and in each call's `stamp`:

| Label        | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `platform`   | Platform: curated and checked by Bike4Mind. Also `verified`.                |
| `verified`   | A cited worked example passed on the server when the function was promoted. |
| `unverified` | No cited worked example was checked when the function was promoted.         |

Only a Bike4Mind admin gives the `platform` label, and only to a live, `verified` function. The label is never read from a function's name or description. Changing the function's code, data files, or sources returns it to draft and removes the label, and so does a promotion or examples change that leaves it `unverified`. Promoting it again, even as `verified`, does not bring the label back; only an admin can.

## Find your functions in the app

The **Functions** page in the app's navigation lists the functions you own under **Mine** and the functions others shared with you under **Shared with me**. Search matches a function's name and description. Each row shows its state (draft, live, or off) and its trust label, and a shared row also shows its owner and whether you reviewed it.

Open one of your own functions to see its inputs and outputs, its label, the data it reads, and its calls in the last 30 days, with who called, the promotion that ran, and how long it took. A call made with one of your own API keys names the key. A call by someone you shared the function with reads "A recipient", with no name or key. **Call function** on an artifact's Function tab runs in your browser and does not appear in the call log.

Open a shared function to review its inputs and outputs and turn on **Allow calls**. You never see its code or its data files. A function leaves **Shared with me** when its owner removes your share or turns it off. While its owner edits it, a shared function stays listed and callable at its last promoted version.

A data file is pinned by choosing it from your files. Only a file you uploaded can be pinned. A file deleted after you chose it is refused as not found.

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

## Run a long call

A call made as above waits for the result and stops at 45 seconds. For a function that runs longer, send `"mode": "async"`:

```bash
curl https://app.bike4mind.com/api/v1/functions/<function-id>/invoke \
  -H 'Authorization: Bearer <your-api-key>' \
  -H 'Content-Type: application/json' \
  -d '{"input":{"load":2000,"span":4},"mode":"async"}'
```

Every check a waiting call makes (the key, the function, the inputs, and their size) runs before the call is queued, so a refused call answers with the same error either way. An accepted call answers `202`:

```json
{ "call_id": "<call-id>", "status": "queued" }
```

Poll the call with the same key:

```bash
curl https://app.bike4mind.com/api/v1/functions/calls/<call-id> \
  -H 'Authorization: Bearer <your-api-key>'
```

`status` is `queued`, then `running`, then `finished`. A finished call carries `outcome`. When `outcome` is `ok`, the answer has `output` and `stamp`, as a waiting call does. Any other outcome carries `error`, and `stamp` when the function ran. A call is readable only by the user who made it, for 24 hours. After that, or for any other id, the poll answers `404`. A call that stopped before it finished, or that was still queued 40 minutes after it was sent, reads `finished` with `outcome` set to `error` and an `error` asking you to send it again.

To stop a call you no longer need, cancel it with the same key while it is `queued` or `running`:

```bash
curl -X POST https://app.bike4mind.com/api/v1/functions/calls/<call-id>/cancel \
  -H 'Authorization: Bearer <your-api-key>'
```

The answer is the call as a poll reads it: `finished`, with `outcome` set to `cancelled`. A queued call never runs. A running call is left to end, but what it returns is discarded, so a later poll still reads `cancelled`. A call that already finished is returned unchanged. Only the user who made the call can cancel it; any other id answers `404`. Cancel is available only here: [MCP](./functions-mcp.md) tool calls and calls from chat wait for their result, so there is nothing to cancel.

## Limits

- The input may be up to 5 MB, and so may the output. An output too large to return answers `502` with `outcome` set to `output_too_large`.
- A saved function can read up to 10 data files and, separately, up to 10 sources, so a call sees at most 20 under `/data`. Together they stay within the size an administrator sets as **Callable Functions: Data Per Function (MB)**, where each source counts at the most it can fetch.
- The function runs for at most 30 seconds unless your organization sets a longer **Callable Function Time Limit** (up to 795 seconds). A call that waits for its result still has 45 seconds to finish; use `"mode": "async"` to run to the full limit.
- Requests are rate limited per user and per route, at your account's per-minute limit. Each response carries the rate-limit headers.

## Errors

Errors use the shared error envelope described in [Errors](./errors.md).

- `403`: the key does not hold `functions:invoke`, or callable functions are turned off for your account.
- `404`: the function is not one of your live functions, or a polled or cancelled call is not yours or has expired.
- `413`: the input is larger than 5 MB.
- `422`: an input does not fit `input_schema`. The `error` names the first field, for example `Input span must be a number.`, and `problems` lists every field with its `path` and `message`.
- `429`: you passed the rate limit, or you already have as many asynchronous calls queued or running as your organization's **Callable Function Pending Call Limit** allows (10 unless it sets another). In the second case `errorCode` is `concurrency_limit_exceeded` and `limit` is the cap; send the call again when one finishes.
- `502`: the function raised an error, ran out of memory, returned outputs that do not fit `output_schema`, or returned too much. `outcome` names which, and `stamp` is included. For `output_invalid`, the `error` names the first output field that does not fit and why, for example `Output report must be at most 2000 characters (it has 4000000).` A text field without a `maxLength` holds at most 2000 characters.
- `503`: no function runtime is available, the runtime was slow to start or did not answer, or the call could not be queued; try again later. On a self-hosted install, where `"mode": "async"` is not available, an asynchronous call also answers `503`.
- `504`: the call ran past its time limit. `errorCode` is `request_timeout`. When your time limit is longer than 45 seconds, the `error` says to send `"mode": "async"`, or on a self-hosted install, where asynchronous calls are not available, that a time limit above 45 seconds cannot be used.
