/**
 * @vitest-environment node
 *
 * Every function that can run the web_search tool must receive SEARXNG_BASE_URL, otherwise the
 * search runs on a single provider with no backup (see infra/searxng.ts). The URL only exists on
 * hosted stages, so each call site spreads it conditionally.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

const WEB_SEARCH_CAPABLE = ['infra/web.ts', 'infra/chatCompletion.ts', 'infra/agentExecutor.ts', 'infra/queues.ts'];

describe('SEARXNG_BASE_URL wiring', () => {
  it.each(WEB_SEARCH_CAPABLE)('%s imports searxngUrl and sets the env only when it exists', rel => {
    const src = read(rel);
    expect(src).toMatch(/import \{ searxngUrl \} from '\.\/searxng';/);
    expect(src).toMatch(/\.\.\.\(searxngUrl \? \{ SEARXNG_BASE_URL: searxngUrl \} : \{\}\)/);
  });
});
