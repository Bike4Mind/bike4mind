import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { z } from 'zod';
import { adminUsageReceiptSchema } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({ CreditTransaction: {}, UsageEvent: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: { findById: vi.fn() } }));

import { buildUsageReceipt, type ReceiptEventRow, type ReceiptLedgerRow } from './adminUsageReceipt';

const id = (n: number) => new Types.ObjectId(n.toString(16).padStart(24, '0'));

const cappedTurn: ReceiptEventRow = {
  _id: id(1),
  requestId: 'quest-1',
  createdAt: new Date('2026-11-05T10:00:00Z'),
  feature: 'chat',
  model: 'claude-opus-5-5',
  source: 'web',
  status: 'ok',
  latencyMs: 530_000,
  inputTokens: 20_000,
  outputTokens: 8,
  cachedInputTokens: 0,
  cacheWriteTokens: 17_983,
  providerInputTokens: 20_329,
  providerOutputTokens: 45_400,
  settledBasis: 'provider',
  costUsd: 1.008,
  creditsCharged: 2016,
  writtenOffCredits: 18,
  reservedCredits: 400,
  requestMeta: {
    stopReason: 'max_tokens',
    maxOutputTokens: 128_000,
    creditCapOutputTokens: 45_400,
    reasoningEffort: 'auto:complex',
    thinkingBudgetTokens: 16_000,
    toolCalls: [{ name: 'web_search', count: 2 }],
    attachmentCount: 2,
    attachmentBytes: 2048,
  },
};

const ledgerRow: ReceiptLedgerRow = {
  _id: id(2),
  type: 'text_generation_usage',
  credits: 2016,
  createdAt: new Date('2026-11-05T10:00:01Z'),
  questId: 'quest-1',
};

/** Keys that would carry user content. None may appear anywhere in the receipt schema. */
const CONTENT_KEYS = [
  'prompt',
  'reply',
  'message',
  'messages',
  'content',
  'text',
  'title',
  'fileName',
  'fileNames',
  'files',
  'notebookName',
  'sessionName',
  'description',
  'arguments',
  'result',
] as const;
// 'input' and 'output' are deliberately absent: tokens.input / tokens.output are numeric counts.

/** Every object key in a Zod schema, with its path, through objects, arrays and optionals. */
const schemaKeys = (schema: z.ZodType, path = ''): string[] => {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return schemaKeys(schema.unwrap() as z.ZodType, path);
  if (schema instanceof z.ZodArray) return schemaKeys(schema.element as z.ZodType, `${path}[]`);
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape).flatMap(([key, child]) => [
      `${path}.${key}`,
      ...schemaKeys(child as z.ZodType, `${path}.${key}`),
    ]);
  }
  return [];
};

describe('buildUsageReceipt', () => {
  it('explains a capped turn: charged vs written off, cap bound, thinking, tools and attachments', () => {
    const receipt = buildUsageReceipt('quest-1', [cappedTurn], [ledgerRow], new Map());

    expect(receipt.totals).toEqual({ cost: 2016, charged: 1998, writtenOff: 18 });
    const [call] = receipt.calls;
    expect(call.credits).toEqual({ cost: 2016, charged: 1998, writtenOff: 18, reserved: 400 });
    expect(call.tokens).toEqual({
      input: 20_329,
      cacheRead: 0,
      cacheWrite: 17_983,
      output: 45_400,
      visibleOutput: 8,
      thinking: 45_392,
      basis: 'provider',
    });
    expect(call.limits).toEqual({
      maxOutputTokens: 128_000,
      capBound: true,
      creditCapOutputTokens: 45_400,
      stoppedForCredits: false,
      reasoningEffort: 'auto:complex',
      thinkingBudgetTokens: 16_000,
    });
    expect(call.toolCalls).toEqual([{ name: 'web_search', count: 2 }]);
    expect(call.attachments).toEqual({ count: 2, totalBytes: 2048 });
    expect(call.detailRecorded).toBe(true);
    expect(receipt.ledger).toEqual([
      {
        id: id(2).toHexString(),
        at: '2026-11-05T10:00:01.000Z',
        type: 'text_generation_usage',
        credits: -1998,
        writtenOffCredits: 18,
      },
    ]);
  });

  it('names the background job on a system row and marks rows recorded before the receipt fields', () => {
    const job = buildUsageReceipt(
      'session-1',
      [
        {
          ...cappedTurn,
          feature: 'operations',
          source: 'system',
          writtenOffCredits: undefined,
          requestMeta: { operation: 'notebook_naming' },
        },
      ],
      [],
      new Map()
    );
    expect(job.calls[0].operation).toBe('notebook_naming');

    const legacy = buildUsageReceipt(
      'quest-1',
      [{ ...cappedTurn, writtenOffCredits: undefined, requestMeta: undefined }],
      [],
      new Map()
    );
    expect(legacy.calls[0].detailRecorded).toBe(false);
    expect(legacy.calls[0].limits.capBound).toBe(false);
  });
});

describe('usage receipt privacy contract', () => {
  it('has no content-shaped field anywhere in the response schema', () => {
    const keys = schemaKeys(adminUsageReceiptSchema);
    const leaves = keys.map(key => key.split('.').pop() ?? '');
    for (const contentKey of CONTENT_KEYS) expect(leaves).not.toContain(contentKey);
  });

  it('strips content that a source row carries, so it never reaches the response', () => {
    const tainted = {
      ...cappedTurn,
      prompt: 'SECRET PROMPT',
      reply: 'SECRET REPLY',
      requestMeta: { ...cappedTurn.requestMeta, fileNames: ['secret-file.pdf'], title: 'Secret notebook title' },
    } as unknown as ReceiptEventRow;
    const receipt = buildUsageReceipt(
      'quest-1',
      [tainted],
      [{ ...ledgerRow, description: 'SECRET' } as ReceiptLedgerRow],
      new Map()
    );
    const wire = JSON.stringify(adminUsageReceiptSchema.parse(receipt));
    expect(wire).not.toMatch(/SECRET|secret-file|Secret notebook/);
  });
});
