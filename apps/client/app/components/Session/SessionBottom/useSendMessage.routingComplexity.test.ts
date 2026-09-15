import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Wiring guard for the agent-mode auto-engage bug: a session that merely had a
 * tool toggled on promoted EVERY prompt to an agent run.
 *
 * `classifyQueryComplexity` short-circuits to `'complex'` whenever a
 * tool-dependent feature is passed, and tool enablement is a session-level
 * setting - so feeding that verdict to `routeQuery` auto-routed every follow-up
 * for the rest of the session. The classifier's own return value is unchanged
 * (rapid reply and the server still depend on the short-circuit); the fix is
 * that this hook must not pass `tools` / `researchMode` for the ROUTING verdict.
 *
 * Source-level assertions (not `renderHook`) match the sibling
 * `useSendMessage.toolsOverride.test.ts`: the hook pulls in ~15 providers, so a
 * full render adds little over locking these invariants.
 */
describe('useSendMessage - routing complexity is computed without tools', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('computes the routing verdict with tools and researchMode passed as undefined', () => {
    expect(source).toMatch(
      /const routingComplexity\s*=\s*classifyQueryComplexity\(\s*prompt,\s*sessionFabFileIdsForRouting,\s*messageFileIdsForRouting,\s*undefined,\s*undefined,\s*sessionAgents\.map\(a => a\.id\)\s*\);/
    );
  });

  it('never passes the tools or researchMode state into the classifier', () => {
    // The two names that trip the short-circuit. Any classifier call that named
    // them would reintroduce the bug, so assert on every call in the file.
    const calls = source.match(/classifyQueryComplexity\([\s\S]*?\);/g) ?? [];
    expect(calls).toHaveLength(1);
    for (const call of calls) {
      expect(call).not.toMatch(/\btools\b/);
      expect(call).not.toMatch(/\bresearchMode\b/);
    }
  });

  it('feeds that verdict, and only that verdict, to routeQuery', () => {
    expect(source).toMatch(/routeQuery\(\{[\s\S]*?\bcomplexity:\s*routingComplexity,[\s\S]*?\}\);/);
  });
});
