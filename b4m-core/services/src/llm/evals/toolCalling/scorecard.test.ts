import { describe, expect, it } from 'vitest';
import { formatToolCallingReport } from './format';
import {
  buildToolCallingReport,
  buildToolCallingScorecard,
  classifyToolCallError,
  type ToolCallingTurn,
} from './scorecard';

const ok = (name: string, parameters: Record<string, unknown> = {}, executionTime = 100) => ({
  name,
  parameters,
  executionTime,
  success: true,
  returnValue: 'ok',
});

const failed = (name: string, returnValue: string) => ({ name, parameters: {}, success: false, returnValue });

describe('classifyToolCallError', () => {
  it('is null for a success', () => {
    expect(classifyToolCallError({ name: 'web_search', success: true })).toBeNull();
  });

  it('marks a call with no recorded outcome as unrecorded', () => {
    expect(classifyToolCallError({ name: 'web_search' })).toBe('unrecorded');
  });

  it('recognizes the adapters malformed-argument observations', () => {
    expect(
      classifyToolCallError(failed('web_search', 'Error: Tool arguments were malformed and could not be parsed.'))
    ).toBe('malformed_arguments');
    expect(
      classifyToolCallError(
        failed('web_search', 'Error: Tool parameters were corrupted due to a stream interruption. Please retry.')
      )
    ).toBe('malformed_arguments');
  });

  it('classifies the wrapped message, not the tool name', () => {
    expect(classifyToolCallError(failed('web_fetch', 'Error processing web_fetch tool: timeout'))).toBe('timeout');
    expect(classifyToolCallError(failed('oauth_lookup', 'Error processing oauth_lookup tool: boom'))).toBe(
      'internal_error'
    );
    expect(classifyToolCallError(failed('oauth_lookup', 'Error running oauth_lookup: boom'))).toBe('internal_error');
    expect(classifyToolCallError(failed('web_fetch', '{"error":"request timed out"}'))).toBe('timeout');
  });

  it('classifies a call by its error before its returnValue', () => {
    expect(
      classifyToolCallError({
        name: 'web_search',
        success: false,
        error: 'Error: Tool arguments were malformed and could not be parsed.',
        returnValue: 'request timed out',
      })
    ).toBe('malformed_arguments');
  });
});

describe('buildToolCallingScorecard', () => {
  it('does not count a retry after a failed call as a repeat', () => {
    const card = buildToolCallingScorecard([
      {
        offeredTools: ['web_fetch'],
        functionCalls: [failed('web_fetch', 'Error processing web_fetch tool: timed out'), ok('web_fetch', {})],
      },
    ]);

    expect(card.tools[0].repeatedCalls).toBe(0);
    expect(card.wasted).toMatchObject({ count: 1, total: 2 });
  });

  it('does not count identical failed calls as repeats', () => {
    const card = buildToolCallingScorecard([
      {
        offeredTools: ['web_fetch'],
        functionCalls: [
          failed('web_fetch', 'Error processing web_fetch tool: timed out'),
          failed('web_fetch', 'Error processing web_fetch tool: timed out'),
        ],
      },
    ]);

    expect(card.tools[0].repeatedCalls).toBe(0);
    expect(card.wasted.count).toBe(2);
  });

  it('scores success, repeats, latency and offered-but-uncalled per tool', () => {
    const turns: ToolCallingTurn[] = [
      {
        offeredTools: ['web_search', 'web_fetch'],
        functionCalls: [
          ok('web_search', { query: 'a', limit: 3 }, 100),
          ok('web_search', { limit: 3, query: 'a' }, 300),
          failed('web_fetch', 'Error processing web_fetch tool: timed out'),
        ],
      },
      { offeredTools: ['web_search', 'web_fetch'], functionCalls: [] },
    ];

    const card = buildToolCallingScorecard(turns);
    const search = card.tools.find(tool => tool.name === 'web_search');
    const fetch = card.tools.find(tool => tool.name === 'web_fetch');

    expect(card.turns).toBe(2);
    expect(card.turnsOffered).toBe(2);
    expect(card.callsPerTurn).toMatchObject({ samples: 2, mean: 1.5, max: 3 });
    expect(card.wasted).toEqual({ count: 2, total: 3, rate: 2 / 3 });

    expect(search).toMatchObject({
      offeredTurns: 2,
      calledTurns: 1,
      offeredUncalled: { count: 1, total: 2, rate: 0.5 },
      invocations: 2,
      success: { count: 2, total: 2, rate: 1 },
      repeatedCalls: 1,
      latencyMs: { samples: 2, p50: 100, p95: 300, max: 300 },
    });
    expect(fetch).toMatchObject({ success: { count: 0, total: 1 }, errorClasses: { timeout: 1 } });
  });

  it('does not count two malformed calls as a repeat, since both are recorded with {} arguments', () => {
    const malformed = 'Error: Tool arguments were malformed and could not be parsed.';
    const card = buildToolCallingScorecard([
      {
        offeredTools: ['web_search'],
        functionCalls: [failed('web_search', malformed), failed('web_search', malformed)],
      },
    ]);
    expect(card.tools[0]).toMatchObject({ repeatedCalls: 0, errorClasses: { malformed_arguments: 2 } });
  });

  it('does not count the corrected retry of a malformed call as a repeat', () => {
    const card = buildToolCallingScorecard([
      {
        offeredTools: ['list_notebooks'],
        functionCalls: [
          failed('list_notebooks', 'Error: Tool arguments were malformed and could not be parsed.'),
          ok('list_notebooks'),
        ],
      },
    ]);
    expect(card.tools[0].repeatedCalls).toBe(0);
    expect(card.wasted).toEqual({ count: 1, total: 2, rate: 0.5 });
  });

  it('keys a repeat on both the tool name and its arguments', () => {
    const card = buildToolCallingScorecard([
      {
        offeredTools: ['web_search', 'web_fetch'],
        functionCalls: [
          ok('web_search', { query: 'a' }),
          ok('web_search', { query: 'b' }),
          ok('web_fetch', { query: 'a' }),
        ],
      },
    ]);
    expect(card.tools.map(tool => tool.repeatedCalls)).toEqual([0, 0]);
    expect(card.wasted.count).toBe(0);
  });

  it('does not count the same call in a later turn as a repeat', () => {
    const turn = { offeredTools: ['web_search'], functionCalls: [ok('web_search', { query: 'a' })] };
    const card = buildToolCallingScorecard([turn, turn]);
    expect(card.tools[0]).toMatchObject({ invocations: 2, repeatedCalls: 0 });
  });

  it('takes nearest-rank percentiles of latency', () => {
    const latencies = Array.from({ length: 20 }, (_, index) => index + 1);
    const card = buildToolCallingScorecard([
      { offeredTools: ['web_search'], functionCalls: latencies.map(ms => ok('web_search', { ms }, ms)) },
    ]);
    expect(card.tools[0].latencyMs).toEqual({ samples: 20, mean: 10.5, p50: 10, p95: 19, max: 20 });
  });

  it('sorts tools by invocations, then offered turns, then name', () => {
    const card = buildToolCallingScorecard([
      {
        offeredTools: ['b_tool', 'c_tool', 'd_tool'],
        functionCalls: [ok('a_tool', { n: 1 }), ok('a_tool', { n: 2 }), ok('c_tool'), ok('b_tool')],
      },
      { offeredTools: ['c_tool'] },
    ]);
    expect(card.tools.map(tool => tool.name)).toEqual(['a_tool', 'c_tool', 'b_tool', 'd_tool']);
  });

  it('counts a call to a tool the turn did not offer', () => {
    const card = buildToolCallingScorecard([{ offeredTools: ['web_search'], functionCalls: [ok('made_up_tool')] }]);
    expect(card.tools.find(tool => tool.name === 'made_up_tool')).toMatchObject({
      offeredTurns: 0,
      callsNotOffered: 1,
    });
  });

  it('leaves an unrecorded call out of the success rate but counts it as wasted', () => {
    const card = buildToolCallingScorecard([{ offeredTools: ['web_search'], functionCalls: [{ name: 'web_search' }] }]);
    expect(card.tools[0]).toMatchObject({
      invocations: 1,
      success: { count: 0, total: 0, rate: null },
      errorClasses: { unrecorded: 1 },
    });
    expect(card.wasted.count).toBe(1);
  });

  it('keeps turns that offered no tools out of calls per turn', () => {
    const card = buildToolCallingScorecard([{ offeredTools: [] }, {}]);
    expect(card).toMatchObject({ turns: 2, turnsOffered: 0, callsPerTurn: { samples: 0, mean: null } });
    expect(card.wasted.rate).toBeNull();
  });
});

describe('buildToolCallingReport', () => {
  it('splits by toolMode, with unset for turns that named none', () => {
    const report = buildToolCallingReport(
      [
        { toolMode: 'smart', offeredTools: ['web_search'], functionCalls: [ok('web_search')] },
        { toolMode: 'fast', offeredTools: [] },
        { offeredTools: ['web_search'] },
      ],
      new Date('2026-10-14T00:00:00Z')
    );

    expect(report.generatedAt).toBe('2026-10-14T00:00:00.000Z');
    expect(report.overall.turns).toBe(3);
    expect(report.byToolMode.smart?.turns).toBe(1);
    expect(report.byToolMode.fast?.turns).toBe(1);
    expect(report.byToolMode.unset?.turns).toBe(1);
  });

  it('formats every segment present', () => {
    const text = formatToolCallingReport(
      buildToolCallingReport([{ toolMode: 'smart', offeredTools: ['web_search'], functionCalls: [ok('web_search')] }])
    );
    expect(text).toContain('overall: 1 turn(s)');
    expect(text).toContain('toolMode=smart');
    expect(text).toContain('web_search: calls 1, success 100.0% (1/1)');
    expect(text).not.toContain('toolMode=unset');
  });

  it('renders the n/a, not-offered and error branches, and orders segments smart, fast, unset', () => {
    // The fixtures are in the reverse of the rendered order, so a formatter that followed insertion
    // order instead of SEGMENT_ORDER would fail the ordering assertions below.
    const text = formatToolCallingReport(
      buildToolCallingReport(
        [
          { offeredTools: [] },
          { toolMode: 'fast', offeredTools: ['web_search'], functionCalls: [ok('made_up_tool')] },
          { toolMode: 'smart', offeredTools: ['web_search'], functionCalls: [{ name: 'web_search' }] },
        ],
        new Date('2026-10-14T00:00:00Z')
      )
    );

    expect(text).not.toContain('not-offered 0');
    expect(text).not.toMatch(/; errors: $/m);
    expect(text.indexOf('toolMode=smart')).toBeLessThan(text.indexOf('toolMode=fast'));
    expect(text.indexOf('toolMode=fast')).toBeLessThan(text.indexOf('toolMode=unset'));

    const smart = text.slice(text.indexOf('toolMode=smart'), text.indexOf('toolMode=fast'));
    const fast = text.slice(text.indexOf('toolMode=fast'), text.indexOf('toolMode=unset'));
    const unset = text.slice(text.indexOf('toolMode=unset'));
    expect(smart).toContain('success n/a');
    expect(smart).toContain('errors: unrecorded 1');
    expect(fast).toContain('not-offered 1');
    expect(unset).toContain('calls per turn: n/a');
  });
});
