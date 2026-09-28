# @bike4mind/workers

Background work that used to live under `apps/client/server`, moved here one category at a time.

| Path | What | Runs as |
|---|---|---|
| `src/events/` | EventBridge event handlers (session naming, summarization, tagging, spider, Slack alarm forwarders, Stripe events) | Lambdas declared in `infra/*.ts` by handler path |
| `src/selfhost/` | Self-host worker runner: SQS long-poll loop, scheduler, and event dispatch | The `worker` service in `compose.selfhost.yaml` |

## Interim bridge into apps/client

Most of the code these handlers call still lives in `apps/client/server`. Until it is extracted into a shared package, `tsconfig.json` and `vitest.config.mts` map `@server/*`, `@client/*` and the other client aliases into `../client`. The dependency is one-way:

- `apps/workers` may import `apps/client/server` code through those aliases.
- `apps/client` must never import `apps/workers` (`@workers/*`). ESLint enforces this, and also stops workers from importing UI code (`@client/app/*`, React, Next, MUI).

Code that both a client route and a worker need belongs on the client side of the bridge (for example `apps/client/server/utils/eventContext.ts` and `apps/client/server/s3/chunkScan.ts`), not here.

## Tests

```bash
pnpm --filter @bike4mind/workers test              # unit suites
pnpm --filter @bike4mind/workers test:integration  # real-Mongo *.e2e.test.ts suites
pnpm --filter @bike4mind/workers typecheck
```

Tests reuse `apps/client/vitest.setup.ts`. CI runs the unit lane in the `misc` test shard and the integration lane in its own `workers-integration` leg.
