import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { LLMContextProps } from '@client/app/contexts/LLMContext';
import { selectTurnPreferences } from './turnPreferences';

describe('selectTurnPreferences', () => {
  it('picks researchMode and skipAutoOffers, and nothing else', () => {
    const researchMode = { enabled: true, configurations: [], syncScrolling: false, comparisonView: 'grid' as const };
    const state = {
      researchMode,
      skipAutoOffers: true,
      agentMode: { enabled: true, source: 'toggle' },
      tools: ['web_search'],
    } as unknown as LLMContextProps;

    expect(selectTurnPreferences(state)).toEqual({ researchMode, skipAutoOffers: true });
  });
});

/**
 * The secondary send paths used to hand-pick LLM settings and silently dropped the composer
 * preferences. Source-level (the components pull in a wide provider tree): every dispatch in
 * these files must spread the shared selector's result.
 */
describe('secondary send paths forward the composer preferences', () => {
  const read = (relativePath: string) => readFileSync(resolve(__dirname, relativePath), 'utf8');

  const spreadsTurnPreferences = /\.\.\.turnPreferences\b/;

  // Brace-matched from the opener's `{`, so a nested callback or object literal in the args
  // doesn't cut the call site short. `opener` must end with the args object's `{`.
  const callSites = (source: string, opener: string) =>
    source
      .split(opener)
      .slice(1)
      .map(rest => {
        let depth = 1;
        for (let index = 0; index < rest.length; index++) {
          if (rest[index] === '{') depth++;
          else if (rest[index] === '}' && --depth === 0) return rest.slice(0, index);
        }
        throw new Error(`Unbalanced braces after ${opener}`);
      });

  it('every QuestMasterReply handleLLMCommand call spreads turnPreferences', () => {
    const sites = callSites(read('../GenAI/QuestMasterReply.tsx'), 'handleLLMCommand({');
    expect(sites).toHaveLength(4);
    for (const site of sites) expect(site).toMatch(spreadsTurnPreferences);
  });

  it('the SessionMiddle edit/retry resend spreads turnPreferences', () => {
    const sites = callSites(read('../Session/SessionMiddle.tsx'), 'handleCommand(commandHandlers, {');
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatch(spreadsTurnPreferences);
  });
});
