import { describe, it, expect } from 'vitest';
import { SimplifiedChatRequestSchema } from './chat';
import { filterKnownTools, B4MLLMToolsList } from './llm';

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

  it.each([0, -5, -0.5])('rejects a non-positive historyCount (%p) rather than coercing it to the default', invalid => {
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
