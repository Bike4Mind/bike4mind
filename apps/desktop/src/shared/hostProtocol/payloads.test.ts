import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import * as payloads from './payloads';

const cases: ReadonlyArray<{ name: string; schema: ZodType; valid: unknown; missingKey: unknown }> = [
  {
    name: 'project inspection',
    schema: payloads.projectInspectionPayloadSchema,
    valid: { directory: '/w', name: 'w', isRepository: false, branches: [], currentBranch: null },
    missingKey: { directory: '/w', isRepository: false },
  },
  {
    name: 'background process',
    schema: payloads.backgroundProcessPayloadSchema,
    valid: { id: 'p1', sessionId: 's1', status: 'running', command: 'sleep 1' },
    missingKey: { id: 'p1', sessionId: 's1' },
  },
  {
    name: 'session',
    schema: payloads.chatSessionPayloadSchema,
    valid: { id: 's1', messages: [] },
    missingKey: { title: 't' },
  },
  { name: 'summary', schema: payloads.chatSessionSummaryPayloadSchema, valid: { id: 's1' }, missingKey: {} },
  {
    name: 'stream event',
    schema: payloads.chatStreamEventPayloadSchema,
    valid: { type: 'start', sessionId: 's1' },
    missingKey: { type: 'start' },
  },
  {
    name: 'status event',
    schema: payloads.chatSessionStatusEventPayloadSchema,
    valid: { sessionId: 's1', status: 'processing' },
    missingKey: { sessionId: 's1' },
  },
  {
    name: 'queued message',
    schema: payloads.chatQueuedMessagePayloadSchema,
    valid: { id: 'q1', sessionId: 's1', text: 'hi' },
    missingKey: { id: 'q1' },
  },
  {
    name: 'queue event',
    schema: payloads.chatQueueEventPayloadSchema,
    valid: { sessionId: 's1', queued: [] },
    missingKey: { sessionId: 's1', queued: 'none' },
  },
  {
    name: 'pending task decision',
    schema: payloads.pendingTaskDecisionPayloadSchema,
    valid: { sessionId: 's1', rootId: 'r1', title: 't', decision: { kind: 'stopped' } },
    missingKey: { sessionId: 's1' },
  },
  {
    name: 'approval answer',
    schema: payloads.chatApprovalAnswerPayloadSchema,
    valid: { decision: 'once' },
    missingKey: {},
  },
  {
    name: 'task decision answer',
    schema: payloads.taskDecisionAnswerPayloadSchema,
    valid: { status: 'skipped' },
    missingKey: {},
  },
  {
    name: 'send request',
    schema: payloads.sendMessageRequestPayloadSchema,
    valid: { sessionId: 's1', text: 'hi' },
    missingKey: { sessionId: 's1' },
  },
  {
    name: 'send result',
    schema: payloads.sendMessageResultPayloadSchema,
    valid: { ok: false, error: 'x' },
    missingKey: {},
  },
  {
    name: 'create result',
    schema: payloads.createCodeSessionResultPayloadSchema,
    valid: { ok: true, session: { id: 's1' } },
    missingKey: { session: { id: 's1' } },
  },
  { name: 'model catalog', schema: payloads.chatModelCatalogPayloadSchema, valid: { models: [] }, missingKey: {} },
  {
    name: 'new session defaults',
    schema: payloads.newSessionDefaultsPayloadSchema,
    valid: { model: 'm', approvalMode: 'ask' },
    missingKey: { model: 'm' },
  },
];

describe.each(cases)('$name guard', ({ schema, valid, missingKey }) => {
  it('accepts a minimal valid object, tolerating extra keys', () => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...(valid as object), addedLater: 1 }).success).toBe(true);
  });

  it('rejects null, arrays and non-objects', () => {
    for (const bad of [null, undefined, [], [valid], 'text', 3]) expect(schema.safeParse(bad).success).toBe(false);
  });

  it('rejects an object missing the key fields', () => {
    expect(schema.safeParse(missingKey).success).toBe(false);
  });
});

describe('createCodeSessionRequestPayloadSchema', () => {
  it('accepts any plain object and rejects the rest', () => {
    expect(payloads.createCodeSessionRequestPayloadSchema.safeParse({}).success).toBe(true);
    expect(payloads.createCodeSessionRequestPayloadSchema.safeParse({ directory: '/tmp/x' }).success).toBe(true);
    expect(payloads.createCodeSessionRequestPayloadSchema.safeParse(null).success).toBe(false);
    expect(payloads.createCodeSessionRequestPayloadSchema.safeParse([]).success).toBe(false);
  });
});
