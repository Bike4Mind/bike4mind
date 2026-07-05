import { describe, it, expect, vi } from 'vitest';
import { Anthropic } from '@anthropic-ai/sdk';
import { AnthropicBatchService, type BatchTransformRequest } from './anthropicBatchService';

/**
 * Build a fake Anthropic client exposing just the `messages.batches` surface
 * the service touches. The service constructor accepts an `Anthropic`
 * instance, so we inject this stub directly - no module mocking needed.
 */
function fakeAnthropic(overrides: {
  create?: (...args: any[]) => any;
  retrieve?: (...args: any[]) => any;
  results?: (...args: any[]) => any;
}): Anthropic {
  return {
    messages: {
      batches: {
        create: overrides.create ?? vi.fn(),
        retrieve: overrides.retrieve ?? vi.fn(),
        results: overrides.results ?? vi.fn(),
      },
    },
  } as unknown as Anthropic;
}

/** Async generator standing in for the SDK's JSONLDecoder of batch results. */
async function* asyncIterableOf<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

const sampleRequests: BatchTransformRequest[] = [
  {
    clientRef: 'guardian/world/2026/abc-123',
    model: 'claude-opus-4-6',
    maxTokens: 8192,
    system: 'sys',
    messages: [{ role: 'user', content: 'a' }],
  },
  {
    clientRef: 'https://example.com/very/long/article/url?q=1',
    model: 'claude-opus-4-6',
    maxTokens: 8192,
    messages: [{ role: 'user', content: 'b' }],
  },
];

describe('AnthropicBatchService', () => {
  describe('submitBatch', () => {
    it('maps each clientRef to a spec-safe req_<i> custom_id and returns the mapping', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'msgbatch_xyz' });
      const svc = new AnthropicBatchService(fakeAnthropic({ create }));

      const result = await svc.submitBatch(sampleRequests);

      expect(result.anthropicBatchId).toBe('msgbatch_xyz');
      expect(result.customIdMap).toEqual([
        { customId: 'req_0', clientRef: 'guardian/world/2026/abc-123' },
        { customId: 'req_1', clientRef: 'https://example.com/very/long/article/url?q=1' },
      ]);

      // Article ids that violate Anthropic's custom_id charset must never be sent raw.
      const submitted = create.mock.calls[0][0];
      expect(submitted.requests.map((r: any) => r.custom_id)).toEqual(['req_0', 'req_1']);
      expect(submitted.requests[0].params).toMatchObject({
        model: 'claude-opus-4-6',
        max_tokens: 8192,
        system: 'sys',
        messages: [{ role: 'user', content: 'a' }],
      });
      // No `system` key when the request omitted it.
      expect('system' in submitted.requests[1].params).toBe(false);
    });

    it('throws on an empty request list', async () => {
      const svc = new AnthropicBatchService(fakeAnthropic({}));
      await expect(svc.submitBatch([])).rejects.toThrow(/no requests/);
    });
  });

  describe('getBatchResults', () => {
    const customIdMap = [
      { customId: 'req_0', clientRef: 'article-A' },
      { customId: 'req_1', clientRef: 'article-B' },
    ];

    it('returns status only while still in_progress (no results fetched)', async () => {
      const retrieve = vi.fn().mockResolvedValue({
        processing_status: 'in_progress',
        request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
      });
      const results = vi.fn();
      const svc = new AnthropicBatchService(fakeAnthropic({ retrieve, results }));

      const out = await svc.getBatchResults('msgbatch_xyz', customIdMap);

      expect(out.processingStatus).toBe('in_progress');
      expect(out.results).toBeUndefined();
      expect(results).not.toHaveBeenCalled();
    });

    it('parses succeeded + errored results and maps custom_id back to clientRef', async () => {
      const retrieve = vi.fn().mockResolvedValue({
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 1, errored: 1, canceled: 0, expired: 0 },
      });
      // Results come back out of order - must be matched on custom_id.
      const results = vi.fn().mockResolvedValue(
        asyncIterableOf([
          {
            custom_id: 'req_1',
            result: {
              type: 'errored',
              error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
            },
          },
          {
            custom_id: 'req_0',
            result: {
              type: 'succeeded',
              message: {
                content: [
                  { type: 'text', text: 'Hello ' },
                  { type: 'text', text: 'world' },
                ],
                usage: { input_tokens: 100, output_tokens: 42 },
              },
            },
          },
        ])
      );
      const svc = new AnthropicBatchService(fakeAnthropic({ retrieve, results }));

      const out = await svc.getBatchResults('msgbatch_xyz', customIdMap);

      expect(out.processingStatus).toBe('ended');
      const byRef = Object.fromEntries((out.results ?? []).map(r => [r.clientRef, r]));

      expect(byRef['article-A']).toEqual({
        clientRef: 'article-A',
        status: 'done',
        reply: 'Hello world',
        tokenUsage: { inputTokens: 100, outputTokens: 42 },
      });
      expect(byRef['article-B']).toMatchObject({ clientRef: 'article-B', status: 'failed', error: 'bad' });
    });

    it('marks canceled / expired items as failed with a reason', async () => {
      const retrieve = vi.fn().mockResolvedValue({
        processing_status: 'ended',
        request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 1, expired: 1 },
      });
      const results = vi.fn().mockResolvedValue(
        asyncIterableOf([
          { custom_id: 'req_0', result: { type: 'canceled' } },
          { custom_id: 'req_1', result: { type: 'expired' } },
        ])
      );
      const svc = new AnthropicBatchService(fakeAnthropic({ retrieve, results }));

      const out = await svc.getBatchResults('msgbatch_xyz', customIdMap);

      const byRef = Object.fromEntries((out.results ?? []).map(r => [r.clientRef, r]));
      expect(byRef['article-A']).toMatchObject({ status: 'failed', error: 'canceled' });
      expect(byRef['article-B']).toMatchObject({ status: 'failed', error: 'expired' });
    });
  });
});
