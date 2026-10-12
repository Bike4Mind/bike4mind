import { describe, expect, it } from 'vitest';
import { buildSystemMessage } from './ChatService';
import { WEB_SEARCH_TURN_BUDGET } from './tools/webSearchLimits';

const build = (roots: string[], web: boolean): string =>
  String(
    buildSystemMessage(roots, false, false, false, [], undefined, [], '', false, false, false, '', true, '', web)
      .content
  );

describe('WEB_GUIDANCE', () => {
  it.each([[['/work']], [[]]])('steers searches toward one query at a time (roots %j)', roots => {
    const text = build(roots, true);
    expect(text).toContain('Search with one well-formed query first, read the results, then refine');
    expect(text).toContain('never several\nvariations at once');
    expect(text).toContain('web_fetch its URL rather than searching again');
    expect(text).toContain(`A turn allows at most ${WEB_SEARCH_TURN_BUDGET} searches`);
    expect(text).toContain('Cite the sources you use with');
  });

  it('is left out when the web tools are not declared', () => {
    expect(build(['/work'], false)).not.toContain('well-formed query');
  });
});
