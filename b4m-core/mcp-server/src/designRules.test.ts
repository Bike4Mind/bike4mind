import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkToolDesign } from './designRules';
import { envelope, fail, ok, paginationInput, pending, resourceLink, UNTRUSTED_NOTE } from './results';
import { defineTool, type Tool } from './tool';

const good = defineTool({
  name: 'get_thing',
  title: 'Get thing',
  description: 'Gets a thing.',
  toolset: 'about',
  scope: null,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { id: z.string() },
  outputSchema: envelope(z.object({ id: z.string() })),
  handler: async () => ok({ id: 'x' }),
});

const mutate = (patch: Record<string, unknown>): Tool => ({ ...good, ...patch }) as Tool;

describe('checkToolDesign', () => {
  it('accepts a conforming tool', () => expect(checkToolDesign(good)).toEqual([]));

  it.each([
    ['name', { name: 'getThing' }, /verb_noun/],
    ['single-word name', { name: 'thing' }, /verb_noun/],
    ['title', { title: ' ' }, /title/],
    [
      'missing hint',
      { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
      /openWorldHint/,
    ],
    ['outputSchema', { outputSchema: {} }, /outputSchema/],
    ['long description', { description: 'x'.repeat(601) }, /600/],
    ['confirm input', { inputSchema: { confirm: z.boolean() } }, /confirm/],
    ['confirm_delete input', { inputSchema: { confirm_delete: z.boolean() } }, /confirm/],
    ['nested confirm input', { inputSchema: { opts: z.object({ confirm: z.boolean() }) } }, /confirm/],
    [
      'confirm behind transform',
      { inputSchema: { opts: z.object({ confirm: z.boolean() }).transform(x => x) } },
      /confirm/,
    ],
    [
      'confirm behind preprocess',
      { inputSchema: { opts: z.preprocess(x => x, z.object({ confirm: z.boolean() })) } },
      /confirm/,
    ],
    ['confirm behind lazy', { inputSchema: { opts: z.lazy(() => z.object({ confirm: z.boolean() })) } }, /confirm/],
    [
      'confirm in a tuple rest',
      { inputSchema: { opts: z.tuple([z.string()]).rest(z.object({ confirm: z.boolean() })) } },
      /confirm/,
    ],
    [
      'confirm nine levels deep',
      {
        inputSchema: {
          a: Array.from({ length: 9 }).reduce<z.ZodTypeAny>(
            (acc: z.ZodTypeAny) => z.object({ n: acc }),
            z.object({ confirm: z.boolean() })
          ),
        },
      },
      /confirm/,
    ],
    [
      'untrusted output behind transform',
      { outputSchema: envelope(z.object({ untrusted_x: z.string() }).transform(x => x)) },
      /untrusted_/,
    ],
    [
      'untrusted output in a union',
      { outputSchema: envelope(z.union([z.object({ untrusted_x: z.string() }), z.object({ y: z.string() })])) },
      /untrusted_/,
    ],
    [
      'untrusted output in a discriminated union',
      {
        outputSchema: envelope(
          z.discriminatedUnion('t', [
            z.object({ t: z.literal('a'), untrusted_x: z.string() }),
            z.object({ t: z.literal('b') }),
          ])
        ),
      },
      /untrusted_/,
    ],
    [
      'untrusted output in a record',
      { outputSchema: envelope(z.record(z.string(), z.object({ untrusted_x: z.string() }))) },
      /untrusted_/,
    ],
    [
      'untrusted output without note',
      { outputSchema: envelope(z.object({ items: z.array(z.object({ untrusted_body: z.string() })) })) },
      /untrusted_/,
    ],
    ['list without limit', { name: 'list_things', inputSchema: {} }, /limit/],
    ['list with wrong default', { name: 'list_things', inputSchema: { limit: z.number().default(50) } }, /limit/],
    ['cursor without limit', { inputSchema: { cursor: z.string().optional() } }, /limit/],
    ['list without cursor', { name: 'list_things', inputSchema: { limit: paginationInput.limit } }, /cursor/],
  ])('flags %s', (_name, patch, re) => {
    expect(checkToolDesign(mutate(patch)).join('\n')).toMatch(re);
  });

  it('terminates on a self-referencing lazy schema', () => {
    type Node = { confirm?: boolean; next?: Node };
    const node: z.ZodType<Node> = z.lazy(() => z.object({ next: node.optional() }));
    expect(checkToolDesign(mutate({ inputSchema: { tree: node } }))).toEqual([]);
  });

  it('accepts untrusted output with the note, and a paginated list', () => {
    const t = mutate({
      name: 'list_things',
      description: `Lists. ${UNTRUSTED_NOTE}`,
      inputSchema: paginationInput,
      outputSchema: envelope(z.object({ untrusted_title: z.string().optional() })),
    });
    expect(checkToolDesign(t)).toEqual([]);
  });
});

describe('result helpers', () => {
  it('ok puts the same JSON in structuredContent and text', () => {
    const r = ok({ a: 1 }, [resourceLink('https://x.test/p/r/a', 'page', 'text/html')]);
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(r.structuredContent);
    expect(r.content[1]).toEqual({
      type: 'resource_link',
      uri: 'https://x.test/p/r/a',
      name: 'page',
      mimeType: 'text/html',
    });
  });
  it('fail is an error and pending carries the job', () => {
    expect(fail('bad').isError).toBe(true);
    expect(pending('confirmation:abc').structuredContent).toMatchObject({ status: 'pending', job: 'confirmation:abc' });
  });
});
