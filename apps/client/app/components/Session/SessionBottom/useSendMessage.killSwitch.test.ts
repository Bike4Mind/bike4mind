import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Consumer-level regression guard for the Agent Mode admin kill switch in
 * useSendMessage - the hook that actually routes a send to `agent_executor`.
 *
 * Agent Mode is admin-gated. A prior P1 fixed useSendMessage bypassing the admin
 * gate by reading `experimentalFeatures.agentMode` directly; every routing signal
 * (`agentToggleActive`, `agentDefaultOn`, `classifierEligible`) is now AND-gated on
 * `agentModeFeatureEnabled = isFeatureEnabled('agentMode')`, so flipping the admin
 * master gate (`EnableAgentMode`) off forces all three to false and no send routes
 * to the executor via the toggle/default/classifier paths.
 *
 * A source-level assertion is used (rather than a full `renderHook`) because
 * `useSendMessage` consumes ~15 context providers; this mirrors the existing
 * useSendMessage.hostCreate.test.ts pattern and locks the invariant cheaply.
 * The test fails if any gate is swapped back to a raw `experimentalFeatures.agentMode`
 * read.
 */
describe('useSendMessage - Agent Mode admin kill switch (regression)', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');
  // Strip comments first so a future comment mentioning the flag can't false-fail
  // the negative assertions, then collapse whitespace so multi-line definitions
  // match a single-line substring.
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const normalized = codeOnly.replace(/\s+/g, ' ');

  it('resolves the Layer-1 gate through useFeatureEnabled, not a raw flag read', () => {
    expect(normalized).toContain("isFeatureEnabled('agentMode')");
    expect(normalized).toContain('const agentModeFeatureEnabled = isFeatureEnabled(');
  });

  it('AND-gates every routing signal on agentModeFeatureEnabled', () => {
    // All four signals that can route a send to agent_executor. autoRouteEnabled
    // feeds routeQuery directly (the heuristic auto-route / recharts bypass path),
    // so it must stay gated alongside the toggle/default/classifier signals.
    expect(normalized).toContain('const agentToggleActive = agentModeFeatureEnabled &&');
    expect(normalized).toContain('const agentDefaultOn = agentModeFeatureEnabled &&');
    expect(normalized).toContain('const classifierEligible = agentModeFeatureEnabled &&');
    expect(normalized).toContain('const autoRouteEnabled = agentModeFeatureEnabled &&');
  });

  it('never reads the raw experimentalFeatures.agentMode flag (the bypass the P1 removed)', () => {
    // Covers dot, optional-chain, and bracket access:
    // experimentalFeatures.agentMode / ?.agentMode / ['agentMode'] / ["agentMode"].
    expect(codeOnly).not.toMatch(/experimentalFeatures\s*\??\s*(\.\s*agentMode|\[\s*['"]agentMode['"]\s*\])/);
    // ...and destructure access: { agentMode } = experimentalFeatures.
    expect(codeOnly).not.toMatch(/\{[^}]*\bagentMode\b[^}]*\}\s*=\s*experimentalFeatures/);
  });
});
