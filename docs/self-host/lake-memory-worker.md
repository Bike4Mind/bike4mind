# Local lake-memory consumer

The self-host worker consumes `LAKE_MEMORY_QUEUE` when configured. It invokes the existing lake-memory handler; platform `EnableLakeMemory` and per-lake opt-in checks still apply. Omitting the queue URL logs a warning and does not register a consumer.

Each receive takes one message, with 1020-second visibility and at most two handler attempts. Visibility starts at receive; the 15-minute extraction lease starts later, after database connection and lookups. The extra two minutes allow pre-claim work, but do not guarantee recovery after an arbitrarily delayed claim. If a crash retry still finds the lease held, the existing handler acknowledges that delivery without extraction. Other queues keep their existing receive batch size.

The handler receives a decreasing ten-minute budget and persists its cursor before sending a continuation. This is a cooperative document-boundary budget, not cancellation of a hung provider request. Existing lease, continuation ceiling, document-failure handling and ledger identity rules remain unchanged. An exception retains the message for redelivery; repeated delivery coalesces the same fact into the same belief but can still repeat inference work. Local poison handling logs and drops messages over the attempt cap; it does not provision a DLQ.

The extractor currently chooses its existing default model. Configure a compatible provider; this registration does not add model selection or promise offline/Ollama extraction. Manual-build transient enqueue failure can still consume its existing daily-cap slot.

## Verification boundary

The co-located integration suite uses a real disposable Mongo server and the actual worker, handler, extractor, lease, cursor and encrypted ledger. External inference and its empty credential table are controlled; queue IO is an in-process delivery fixture. Assertions read the persisted decrypted belief and source IDs, compare twelve-minute crash redelivery with sixteen-minute recovery and verify the configured seventeen-minute visibility after a ninety-second pre-claim delay, exercise continuation-send failure and redelivery, and verify repeated-delivery identity. These tests establish application behavior, not live broker durability, model quality or Kubernetes end-to-end parity.

Run with Node 24:

```sh
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test __tests__/mongoTestTimeoutBudget.test.ts
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/workers test src/selfhost/lakeMemoryQueue.test.ts src/selfhost/selfHostWorker.test.ts
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/workers test:integration src/selfhost/lakeMemoryQueue.e2e.test.ts
```
