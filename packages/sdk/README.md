# @bike4mind/sdk

A small, typed client for the Bike4Mind HTTP API. Its types are generated from the API's OpenAPI spec, so every operation in the spec is callable with typed path params, query, body and response, with no hand-written code per endpoint.

- Runs anywhere with a global `fetch`: Node 18+, Bun, Deno, browsers.
- One runtime dependency (`eventsource-parser`, for streaming).
- Responses are typed, not validated.

The full API reference, including scopes, rate limits and async jobs, is served by every deployment at `/api/v1/docs` (the raw spec is at `/api/v1/openapi.json`).

## Install

```sh
npm install @bike4mind/sdk
```

## Create a client

```ts
import { createClient } from '@bike4mind/sdk';

const b4m = createClient({
  baseUrl: 'https://app.example.com', // your deployment; there is no default
  apiKey: process.env.B4M_API_KEY, // sent as `Authorization: Bearer b4m_live_...`
});
```

Other options:

- `getAuthToken: () => string | undefined | Promise<...>` runs before every request, and its token wins over `apiKey`. Use it for JWTs you refresh yourself.
- `fetch` is a custom fetch for timeouts, retries, proxies or tests.
- `headers` are sent on every request.

## Call any operation

`call(operationId, args)` takes the spec's `operationId`. `params` (path), `query` and `body` are typed per operation, and `params`/`body` are required exactly when the operation requires them.

```ts
const me = await b4m.call('getMe');
const models = await b4m.call('listModels', { query: { limit: 20 } });
const project = await b4m.call('getProject', { params: { id: projectId } });
await b4m.call('deleteProject', { params: { id: projectId } }); // 204: resolves undefined
```

`call` returns the parsed JSON body. A non-JSON 2xx body (for example the default binary audio from `synthesizeSpeech`) throws; use `raw` or the `tts`/`music`/`soundEffects` helpers. For a binary or streamed body, `raw(operationId, args)` returns the 2xx `Response` itself. `operations` maps each id to its `{ method, path }`.

## Stream a completion

```ts
for await (const event of b4m.completions({
  model: 'claude-sonnet-5-5',
  messages: [{ role: 'user', content: 'Hi' }],
})) {
  if (event.type === 'content') process.stdout.write(event.text);
  if (event.type === 'error') throw new Error(event.message);
}
```

A failure before the stream starts throws `B4mApiError`. A server `{ type: 'error' }` event is yielded, not thrown. Pass `{ signal }` to cancel, or `{ url }` to stream from a different endpoint. An absolute `url` receives the same `Authorization` header, so pass only an origin you trust. A stream that ends without `[DONE]` and without an error event throws.

## Chat and image jobs

Chat turns and image generations and edits are queued. Each helper returns a handle whose `poll()` waits for the job to finish:

```ts
const turn = await b4m.chat({ message: 'Summarize my last notebook' });
const quest = await turn.poll({ timeoutMs: 120_000 });
console.log(quest.reply);

const image = await b4m.generateImage({ prompt: 'a red bicycle', model: 'gpt-image-1' });
const { images } = await image.poll();
```

`poll` backs off from `intervalMs` (default 1000 ms) up to `maxIntervalMs` (default 5000 ms). It throws `B4mQuestError` when the job ends with `type: "error"` (`reason: 'error'`), ends `stopped` (`'stopped'`), or outlives `timeoutMs` (`'timeout'`). `error.quest` holds the last state. To resume polling a known quest id, use `pollQuest(id)`.

Other async jobs (agent executions, video generations, file uploads) are plain `call`s: start the job, then poll its `get*` operation.

## Audio

`tts`, `music` and `soundEffects` always request `encoding: 'base64'`, so a result too large for the response comes back as the `delivery: 'url'` variant instead of a redirect. A server that predates `encoding` streams raw bytes; the SDK rebuilds the same inline shape from those bytes and the `X-B4M-Audio-*` headers.

```ts
const result = await b4m.tts({ text: 'Hello', voice: 'alloy' });
if (result.kind === 'audio' && result.data.delivery === 'inline') {
  const bytes = Buffer.from(result.data.audio, 'base64');
}
```

`tts` also returns `{ kind: 'saved-too-large', data }` when an older server rejects oversized audio with a 413 but kept a saved copy (`data.fabFileId`). To get binary audio directly, use `raw('synthesizeSpeech', { body: { text, encoding: 'binary' } })`.

## Errors

Any non-2xx response throws `B4mApiError`:

```ts
import { B4mApiError } from '@bike4mind/sdk';

try {
  await b4m.call('getMe');
} catch (error) {
  if (error instanceof B4mApiError) {
    error.status; // HTTP status
    error.errorCode; // e.g. 'insufficient_credits'; branch on this, not on the message
    error.requestId; // body request_id or the X-Request-ID header
    error.retryAfterSeconds; // from Retry-After on a 429
    error.body; // the parsed body
  }
}
```

## Types

Generated types are exported for your own code: `paths`, `components`, `Operations`, and the shortcut `Schemas` (for example `Schemas['ErrorResponse']`). Per-operation helpers are `JsonBody<'createProject'>`, `JsonResponse<'getQuest'>`, `PathParams<...>` and `QueryParams<...>`.

## Regenerating the types (contributors)

`src/generated/` is generated from `apps/client/public/openapi.json` and checked in. From the repo root:

```sh
pnpm turbo:openapi:generate   # regenerates the spec, then the SDK types
```

`pnpm --filter @bike4mind/sdk generate` regenerates only the SDK types from the current spec. CI fails when either is stale.
