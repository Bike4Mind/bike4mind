---
title: Functions
description: List, read, review, and call the live functions you own or that were shared with you, get each result with a stamp of what it ran on, and write, test, promote, and share your functions.
sidebar_position: 7
---

# Functions

A function is a Python artifact you saved as a function and promoted to live after its tests passed on the server. You list the live functions you reach with `GET /api/v1/functions`, read one with `GET /api/v1/functions/{id}`, and call one with `POST /api/v1/functions/{id}/invoke`. A function someone shared with you is [reviewed](#review-a-function-shared-with-you) with `POST /api/v1/functions/{id}/review` before you call it. You can also [author a function](#author-a-function) from nothing to live and shared without opening the app. Use your deployment's base URL; the hosted URL is `https://app.bike4mind.com/api/v1`.

## Create a Functions key

In your profile, open the API keys tab, choose **New key**, and pick the **Functions** access level. The key holds the `functions:invoke` scope: it reaches only the calling routes on this page and the [MCP endpoint](./functions-mcp.md). Tick **Also write, test, promote, and share your functions** to add `functions:author`, which reaches only the [authoring routes](#author-a-function). The two may share a key, and a request to mint either together with any other scope is refused. `functions:author` calls nothing, and `functions:invoke` authors nothing. The Functions level appears only while callable functions are turned on for your account.

An app that signs you in with Bike4Mind can hold the same two scopes on the short-lived key its server exchanges for you, once an admin grants them to the app and you approve them on its consent screen. That key may also hold `ai:generate` and `me:read`, and it reaches the routes on this page and those its other scopes name, nothing else. See [Building on B4M](../developers/building-on-b4m.md), section 5.

Each call answers for the key's owner. A key reaches the live functions its owner owns and the live functions other people shared with them. A draft, a turned-off function, a function whose artifact was deleted, and another person's function that was not shared with you all answer `404`, the same as an id that does not exist.

## List your live functions

```bash
curl https://app.bike4mind.com/api/v1/functions \
  -H 'Authorization: Bearer <your-api-key>'
```

The response is `{ "data": [...], "next_cursor": ... }`. Each entry has `id`, `slug`, `description`, `group`, `review_status`, `trust_label`, `pin_version`, `pin_seq`, and `updated_at`. Pass `limit` and the previous `next_cursor` as `cursor` to read the next page; `next_cursor` is `null` on the last page.

`group` says whose the function is:

| Group      | Meaning                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `own`      | You own it.                                                                                                   |
| `shared`   | Shared with you by name, project, or organization.                                                            |
| `platform` | [Offered to everyone signed in](#functions-offered-to-everyone-signed-in), and not shared with you otherwise. |

A function both shared with you and offered to everyone signed in lists as `shared`, and stays listed when the offer ends. Your own function is always `own`.

`review_status` is `null` on your own functions. On a `shared` or `platform` function it is `needs_review` until you allow it, `allowed` once you have, and `withdrawn` after you take the allow back. A function whose interface changed since you allowed it reads `needs_review` again. Only an `allowed` function can be called. When two functions you reach have the same name, the shared one's `slug` ends in `_` and the last six characters of its id.

### Trust labels

`trust_label` is set on every live function, in the list, in a single read, and in each call's `stamp`:

| Label        | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `platform`   | Platform: curated and checked by Bike4Mind. Also `verified`.                |
| `verified`   | A cited worked example passed on the server when the function was promoted. |
| `unverified` | No cited worked example was checked when the function was promoted.         |

Only a Bike4Mind admin gives the `platform` label, and only to a live, `verified` function. The label is never read from a function's name or description. Changing the function's code, data files, or sources returns it to draft and removes the label, and so does a promotion or examples change that leaves it `unverified`. Promoting it again, even as `verified`, does not bring the label back; only an admin can.

### Functions offered to everyone signed in

An admin can offer a `platform` function to everyone signed in. Every person then finds it under **Shared with me**, the same as a function shared with them, and reviews it before their first call. Over the API it lists and reads with `group: "platform"` and `shared_via: "signed_in"` before and after the review, and calls once reviewed. If it is also shared with you, it lists and reads as that share instead, with `group: "shared"`. The offer needs the label: it ends at once when an admin withdraws it or removes the label, or when an edit removes the label. When an admin withdraws the offer or removes the label, a person the offer alone reached starts at review again if it is offered again. An offer shows you the function's inputs and outputs only, never its code, its calls, or its data files, not even their names: a call's `stamp` lists each data file by its hash and size with an empty `name`. It does not add you to any project or organization.

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

The response is `{ "data": { ... } }` with the list fields plus `input_schema` and `output_schema`, the JSON Schemas of the function's inputs and outputs, and three fields about a share: `shared_by` (the `name` of who shared it), `shared_via` (`person`, `project`, `organization`, or `signed_in` for a [function offered to everyone signed in](#functions-offered-to-everyone-signed-in)), and `review_hash`. All three are `null` on your own functions. A function shared with you reads the same before and after you review it. The pinned code, its data files, and its sources are never returned.

## Review a function shared with you

A function someone shares with you is listed with `review_status: "needs_review"`, and a call to it answers `403` with `errorCode: "review_required"` until you allow it. Read it first, then send back the `review_hash` you were shown:

```bash
curl https://app.bike4mind.com/api/v1/functions/<function-id>/review \
  -H 'Authorization: Bearer <your-api-key>' \
  -H 'Content-Type: application/json' \
  -d '{"action":"allow","review_hash":"<review_hash>"}'
```

The answer is the function as a read returns it, now with `review_status: "allowed"`, and your next call runs. An allow keeps the mode you chose in the app for when chat and agent runs ask before calling it, or the default on a first allow; the API does not change it, and calls over this API never ask. Send `{"action":"withdraw"}` to take the allow back; calls are refused with `review_required` again until you allow it once more. This is the same review as **Allow calls** in the app, and either one shows in the other.

The route needs `functions:invoke`. Only a function shared with you can be reviewed: your own function, a function not shared with you, and an id that does not exist answer `404`. If the function's interface changed after you read it, an allow answers `409` with `code: "review_conflict"`; read it again and allow the new `review_hash`. A withdraw of a function you never allowed answers `409` with `code: "not_reviewed"`.

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

## Author a function

With `functions:author` a key writes, tests, promotes, and shares its owner's own functions, with no visit to the app. Each route answers for the key's owner only: a function shared with you and another person's function both answer `404`, the same as an id that does not exist. Every route is refused with `403` while callable functions are turned off for your account.

| Route                                         | What it does                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /api/v1/functions`                      | Saves `code` and its `contract` (the `FUNCTION` object, as JSON) as a new draft.                |
| `GET /api/v1/functions/mine`                  | Lists your functions in every state, without their code.                                        |
| `GET /api/v1/functions/{id}/source`           | Reads one of your functions with its code, contract, examples, data, sources, and share.        |
| `PUT /api/v1/functions/{id}/code`             | Saves new `code` and `contract` with the `pin_version` you read. The function returns to draft. |
| `PATCH /api/v1/functions/{id}`                | Sets `enabled` (turn it off or on) or `approval`, one per request.                              |
| `DELETE /api/v1/functions/{id}`               | Deletes the function, its data files, and its shares.                                           |
| `PUT /api/v1/functions/{id}/examples`         | Replaces its worked examples.                                                                   |
| `POST /api/v1/functions/{id}/test-runs`       | Runs its declared tests on the server, or the ones named in `tests`.                            |
| `POST /api/v1/functions/{id}/data`            | Pins a file you uploaded as `/data/<name>`.                                                     |
| `DELETE /api/v1/functions/{id}/data/{name}`   | Unpins a data file.                                                                             |
| `PUT /api/v1/functions/{id}/sources`          | Replaces its sources. Leave one out to remove it.                                               |
| `POST /api/v1/functions/{id}/promote`         | Makes it live once every test and worked example has passed on the server.                      |
| `GET /api/v1/functions/{id}/share`            | Reads who it is shared with.                                                                    |
| `PUT /api/v1/functions/{id}/share`            | Replaces the share of a live function: people, a project, or an organization.                   |
| `DELETE /api/v1/functions/{id}/share`         | Stops sharing it.                                                                               |
| `GET /api/v1/functions/{id}/recipient?email=` | Finds the person holding an address, to name in a share. 20 lookups a minute.                   |
| `GET /api/v1/functions/{id}/calls`            | Summarizes its calls of the last 30 days.                                                       |

A typical run from nothing to shared: create the draft, add a cited worked example, run the tests, promote, look up each person by address, and share. The same key then calls it with `functions:invoke`.

```bash
curl https://app.bike4mind.com/api/v1/functions \
  -H 'Authorization: Bearer <your-api-key>' \
  -H 'Content-Type: application/json' \
  -d '{"code":"FUNCTION = {...}\n\ndef run(inputs):\n    ...\n","contract":{"name":"beam_midspan_deflection", ...}}'
```

A refused request carries `error` and, where the reason is one you can act on, `code`: for example `version_changed` when the function changed since you read it (read it again and resend with the new `pin_version`), `invalid_contract` with `problems`, `name_changed`, `not_live` when you share a draft, and `no_cases` when you promote a function with no test and no worked example. A body that does not fit the route answers `422`. A test run or promotion answers `503` while no function runtime is available.

## Limits

- The input may be up to 5 MB, and so may the output. An output too large to return answers `502` with `outcome` set to `output_too_large`.
- A saved function can read up to 10 data files and, separately, up to 10 sources, so a call sees at most 20 under `/data`. Together they stay within the size an administrator sets as **Callable Functions: Data Per Function (MB)**, where each source counts at the most it can fetch.
- The function runs for at most 30 seconds unless your organization sets a longer **Callable Function Time Limit** (up to 795 seconds). A call that waits for its result still has 45 seconds to finish; use `"mode": "async"` to run to the full limit.
- Requests are rate limited per user and per route, at your account's per-minute limit. Each response carries the rate-limit headers.

## Errors

Errors use the shared error envelope described in [Errors](./errors.md).

- `403`: the key does not hold the scope the route names (`functions:invoke` to list, read, review, and call; `functions:author` to author), or callable functions are turned off for your account. A call to a function shared with you that you have not allowed, or whose allow you withdrew, answers `403` with `errorCode: "review_required"`; [review it](#review-a-function-shared-with-you) and call again.
- `404`: the function is not one of your live functions or one shared with you (for an authoring route, not one of your functions), or a polled or cancelled call is not yours or has expired.
- `409`: a review's `review_hash` no longer matches the function (`code: "review_conflict"`), or there is no allow to withdraw (`code: "not_reviewed"`).
- `413`: the input is larger than 5 MB.
- `422`: an input does not fit `input_schema`. The `error` names the first field, for example `Input span must be a number.`, and `problems` lists every field with its `path` and `message`.
- `429`: you passed the rate limit, or you already have as many asynchronous calls queued or running as your organization's **Callable Function Pending Call Limit** allows (10 unless it sets another). In the second case `errorCode` is `concurrency_limit_exceeded` and `limit` is the cap; send the call again when one finishes.
- `502`: the function raised an error, ran out of memory, returned outputs that do not fit `output_schema`, or returned too much. `outcome` names which, and `stamp` is included. For `output_invalid`, the `error` names the first output field that does not fit and why, for example `Output report must be at most 2000 characters (it has 4000000).` A text field without a `maxLength` holds at most 2000 characters.
- `503`: no function runtime is available, the runtime was slow to start or did not answer, or the call could not be queued; try again later. On a self-hosted install, where `"mode": "async"` is not available, an asynchronous call also answers `503`.
- `504`: the call ran past its time limit. `errorCode` is `request_timeout`. When your time limit is longer than 45 seconds, the `error` says to send `"mode": "async"`, or on a self-hosted install, where asynchronous calls are not available, that a time limit above 45 seconds cannot be used.
