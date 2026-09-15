import { describe, it, expect } from 'vitest';
import { SimplifiedChatRequestSchema, ChatAckSchema } from './chat';
import { filterKnownTools, B4MLLMToolsList } from './llm';

const baseAck = {
  id: 'quest-1',
  status: 'done',
  message_received: true,
  timestamp: '2026-09-15T00:00:00Z',
  model: 'test-model',
  tracking_info: { quest_id: 'quest-1', check_status_url: '/api/quests/quest-1' },
};

/**
 * `type`/`errorCode` model the classifier a caller matches on to tell a credit/spend-cap
 * failure from a real answer (chat.contract.ts's 200 description) - both absent on the
 * immediate async ack, present on the `wait: true` body and the polled quest once terminal.
 */
describe('ChatAckSchema error classifier', () => {
  it('accepts the shape with no type/errorCode (the immediate async ack)', () => {
    const result = ChatAckSchema.safeParse(baseAck);
    expect(result.success).toBe(true);
    expect(result.data?.type).toBeUndefined();
    expect(result.data?.errorCode).toBeUndefined();
  });

  it.each(['insufficient_credits', 'spend_cap_exceeded'] as const)(
    'accepts type: "error" with errorCode: "%s"',
    errorCode => {
      const result = ChatAckSchema.safeParse({ ...baseAck, type: 'error', errorCode });
      expect(result.success).toBe(true);
      expect(result.data?.type).toBe('error');
      expect(result.data?.errorCode).toBe(errorCode);
    }
  );

  it('accepts a real answer with type: "message" and no errorCode', () => {
    const result = ChatAckSchema.safeParse({ ...baseAck, type: 'message' });
    expect(result.success).toBe(true);
    expect(result.data?.errorCode).toBeUndefined();
  });

  it('rejects an errorCode outside the quest-failure vocabulary (narrows API_ERROR_CODES)', () => {
    // provider_not_configured/provider_rejected are real API_ERROR_CODES entries, but not
    // quest-failure reasons - QUEST_ERROR_CODES narrows the shared union on purpose.
    const result = ChatAckSchema.safeParse({ ...baseAck, type: 'error', errorCode: 'provider_not_configured' });
    expect(result.success).toBe(false);
  });
});

/**
 * Pins the public-API schema hygiene rule this endpoint's contract migration
 * established: a public request schema fails LOUD (no `.catch()`, no top-level
 * `.transform()`), and domain filtering that used to hide inside the schema now
 * lives in `filterKnownTools` where a handler calls it explicitly.
 */
describe('SimplifiedChatRequestSchema fail-loud defaults', () => {
  const parse = (body: Record<string, unknown>) => SimplifiedChatRequestSchema.safeParse({ message: 'hi', ...body });

  it('defaults an omitted historyCount to 10', () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect(result.data?.historyCount).toBe(10);
  });

  it.each([0, -5, -0.5])('rejects a non-positive historyCount (%s) rather than coercing it to the default', invalid => {
    // Pre-contract this was `.prefault(10).catch(10)`, which silently swallowed
    // any bad value. Public schemas must surface the error as a 422 instead.
    expect(parse({ historyCount: invalid }).success).toBe(false);
  });

  it('rejects a temperature outside the documented 0-2 range', () => {
    expect(parse({ temperature: 3 }).success).toBe(false);
  });

  it('keeps `tools` an unfiltered string[] so the wire schema stays OpenAPI-representable', () => {
    // Unknown ids must survive validation - dropping them is the handler's job, not
    // the schema's. A transform here would make the schema opaque to zod-to-openapi.
    const result = parse({ tools: ['websearch', 'definitely_not_a_tool'] });
    expect(result.success).toBe(true);
    expect(result.data?.tools).toEqual(['websearch', 'definitely_not_a_tool']);
  });

  it('requires a message', () => {
    expect(SimplifiedChatRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts an optional organizationId billing target and leaves it undefined when omitted', () => {
    expect(parse({}).data?.organizationId).toBeUndefined();
    const withOrg = parse({ organizationId: 'org-123' });
    expect(withOrg.success).toBe(true);
    expect(withOrg.data?.organizationId).toBe('org-123');
  });
});

describe('filterKnownTools', () => {
  const known = B4MLLMToolsList[0];

  it('returns [] for undefined (the omitted-field case handlers hit most)', () => {
    expect(filterKnownTools(undefined)).toEqual([]);
  });

  it('keeps recognized tool ids in the order given', () => {
    const two = B4MLLMToolsList.slice(0, 2);
    expect(filterKnownTools(two)).toEqual(two);
  });

  it('drops unknown ids while keeping the known ones', () => {
    expect(filterKnownTools(['not_a_tool', known, ''])).toEqual([known]);
  });

  it('drops everything when nothing is recognized', () => {
    expect(filterKnownTools(['nope', 'also_nope'])).toEqual([]);
  });

  it('does not treat inherited Array/Object properties as tools', () => {
    // `includes` on the id list is the guard; a prototype-key probe must not slip through.
    expect(filterKnownTools(['constructor', 'toString', '__proto__'])).toEqual([]);
  });
});
