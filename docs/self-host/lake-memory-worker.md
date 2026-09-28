# Local lake-memory consumer

The self-host worker consumes `LAKE_MEMORY_QUEUE` when configured. It invokes the existing lake-memory handler; platform `EnableLakeMemory` and per-lake opt-in checks still apply. Omitting the queue URL logs a warning and does not register a consumer.

Each receive takes one message, with 960-second visibility and at most two handler attempts. Visibility exceeds the extractor's 15-minute lease: after a crash, a second delivery can reclaim the lease rather than acknowledge the still-locked job. Other queues keep their existing receive batch size.

The handler receives a decreasing ten-minute budget and persists its cursor before sending a continuation. This is a cooperative document-boundary budget, not cancellation of a hung provider request. Existing lease, continuation ceiling, document-failure handling and ledger identity rules remain unchanged. An exception retains the message for redelivery; repeated delivery coalesces the same fact into the same belief but can still repeat inference work. Local poison handling logs and drops messages over the attempt cap; it does not provision a DLQ.

The extractor currently chooses its existing default model. Configure a compatible provider; this registration does not add model selection or promise offline/Ollama extraction. Manual-build transient enqueue failure can still consume its existing daily-cap slot.

## Verification boundary

The co-located integration suite uses a real disposable Mongo server and the actual worker, handler, extractor, lease, cursor and encrypted ledger. External inference and its empty credential table are controlled; queue IO is an in-process delivery fixture. Assertions read the persisted decrypted belief and source IDs, compare twelve-minute crash redelivery with sixteen-minute recovery, exercise continuation-send failure and redelivery, and verify repeated-delivery identity. These tests establish application behavior, not live broker durability, model quality or Kubernetes end-to-end parity.

Run with Node 24:

```sh
VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test server/worker/lakeMemoryQueue.test.ts server/worker/lakeMemoryQueue.integration.test.ts server/worker/selfHostWorker.test.ts
```
