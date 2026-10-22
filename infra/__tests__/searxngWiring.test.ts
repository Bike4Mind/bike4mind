/**
 * @vitest-environment node
 *
 * Every function that can run the web_search tool must receive SEARXNG_BASE_URL, otherwise the
 * search runs on a single provider with no backup (see infra/searxng.ts). The URL only exists on
 * hosted stages, so each call site spreads it conditionally inside the function's `environment`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const INFRA_DIR = join(__dirname, '..');
const read = (file: string) => readFileSync(join(INFRA_DIR, file), 'utf8');

const SPREAD = '...(searxngUrl ? { SEARXNG_BASE_URL: searxngUrl } : {})';

/** infra file -> text that must appear on the nearest declaration line above the environment block. */
const WEB_SEARCH_CAPABLE: Record<string, string> = {
  'web.ts': 'sst.aws.Nextjs',
  'chatCompletion.ts': 'sst.aws.Service',
  'agentExecutor.ts': 'queueHandlers/agentExecutor.handler',
  'queues.ts': 'dataLakeResearchRun',
  'functions.ts': 'slackQuestProcessor',
};

/** Source of each top-level `environment: { ... }` object, found by brace matching. */
function environmentBlocks(src: string): Array<{ start: number; body: string }> {
  const blocks: Array<{ start: number; body: string }> = [];
  const re = /environment: \{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        blocks.push({ start: m.index, body: src.slice(open, i + 1) });
        break;
      }
    }
  }
  return blocks;
}

describe('SEARXNG_BASE_URL wiring', () => {
  it.each(Object.entries(WEB_SEARCH_CAPABLE))(
    '%s sets the env only when it exists, in the right function',
    (file, owner) => {
      const src = read(file);
      expect(src).toContain("import { searxngUrl } from './searxng';");

      const block = environmentBlocks(src).find(b => b.body.includes(SPREAD));
      expect(block, 'spread must sit inside an environment block').toBeDefined();

      const declarations = src
        .slice(0, block!.start)
        .split('\n')
        .filter(line => /handler:|new sst\.aws\.|CONFIG = \{/.test(line));
      expect(declarations[declarations.length - 1]).toContain(owner);
    }
  );

  it('is referenced only by files on the web_search-capable list', () => {
    const referencing = readdirSync(INFRA_DIR)
      .filter(f => f.endsWith('.ts') && f !== 'searxng.ts')
      .filter(f => read(f).includes('searxngUrl'));
    expect(referencing.sort()).toEqual(Object.keys(WEB_SEARCH_CAPABLE).sort());
  });
});
