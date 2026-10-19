import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Static pins for the `processExecution` and subagent `toolDeps` blocks. `processExecution` has no
 * harness, so the wiring is checked against the source directly, the way
 * checkToolAvailabilityWired.test.ts pins the availability wiring. Kept in the unit lane (NOT the
 * real-Mongo `*.e2e.test.ts` lane) so a default `pnpm --filter @bike4mind/workers test` runs them.
 */
describe('agentExecutor toolDeps wiring', () => {
  const source = readFileSync(join(__dirname, 'agentExecutor.ts'), 'utf8');

  it('spreads the lake write adapters into both the main and the subagent toolDeps', () => {
    expect(source.match(/\.\.\.lakeWriteToolDb,/g)).toHaveLength(2);
  });

  it('stamps the run organization on both toolDeps', () => {
    expect(source).toMatch(/const toolDeps: ToolBuilderDeps = \{[^}]*organizationId: execution\.organizationId,/);
    expect(source).toMatch(/const toolDeps: ToolBuilderDeps = \{[^}]*organizationId: child\.organizationId,/);
  });

  // Both are optional on ToolContext.db, so dropping either typechecks and edit_image then refuses
  // the owner's own generated-image keys with only a logged warning.
  it('wires the generated-image owner lookup into both the main and the subagent toolDeps', () => {
    expect(source.match(/findAllByIds: sessionRepository\.findAllByIds\.bind\(sessionRepository\),/g)).toHaveLength(2);
    expect(source.match(/quests: questRepository,/g)).toHaveLength(2);
  });

  // executionTurnAuth carries both authOrigin and the key id (see its tests in turnAuth.test.ts).
  it('forwards the run turn auth to both toolDeps and to every child it spawns', () => {
    expect(source).toMatch(/const toolDeps: ToolBuilderDeps = \{[^}]*\.\.\.executionTurnAuth\(execution\),/);
    expect(source).toMatch(/const toolDeps: ToolBuilderDeps = \{[^}]*\.\.\.executionTurnAuth\(child\),/);
    expect(source).toMatch(/const baseFields = \{[^}]*\.\.\.executionTurnAuth\(execution\),/);
    expect(source).toMatch(/nodeDefaults: \{[^}]*\.\.\.executionTurnAuth\(execution\),/);
  });

  it('carries the scope denials to every child row and the child MCP denylist', () => {
    const baseFieldsAt = source.indexOf('const baseFields = {');
    expect(baseFieldsAt).toBeGreaterThan(-1);
    expect(source.slice(baseFieldsAt, source.indexOf('};', baseFieldsAt))).toContain(
      '...(execution.scopeDeniedTools?.length && { scopeDeniedTools: execution.scopeDeniedTools }),'
    );
    expect(source).toMatch(/nodeDefaults: \{[^}]*scopeDeniedTools: execution\.scopeDeniedTools,/);
    expect(source).toMatch(
      /sessionDisabledTools: \[\.\.\.sessionDeniedTools\(session\), \.\.\.\(child\.scopeDeniedTools \?\? \[\]\)\]/
    );
  });

  // The MCP tools are merged into the built list AFTER the native name filter, so this denylist is
  // the only thing that reaches a `server__tool` id - and it is the only place the surface denials
  // do. `processExecution` has no harness, so the call itself is pinned here.
  it('builds the parent MCP denylist from the surface-aware session denials', () => {
    expect(source).toMatch(/sessionDisabledTools: mcpSessionDisabledTools\(\s*sessionDeniedTools\(session\),/);
  });

  // The Lattice opt-in pool is granted from a subagent's own `allowedTools`, bypassing the parent's
  // `enabledTools` filter, so the session denials have to be applied to it on their own. The
  // subagent path also carries the child's own scope denials, so the pin names the full argument.
  it('filters both subagent Lattice opt-in pools by the session and scope denials', () => {
    expect(source.match(/buildSubagentLatticeToolPool\([^)]*sessionDeniedTools\(session\)/g)).toHaveLength(2);
    expect(source).toMatch(
      /buildSubagentLatticeToolPool\([^)]*\[\.\.\.sessionDeniedTools\(session\), \.\.\.\(child\.scopeDeniedTools \?\? \[\]\)\]/
    );
  });

  it('gates the profile tool resolution on whether the connection has an approver', () => {
    expect(source).toMatch(
      /resolveInvocationEnabledTools\(\{[^}]*hasApprover: hasApprover\(execution\.connectionId\),/
    );
  });

  it('subtracts the persisted scope denials in the final tool policy pass', () => {
    expect(source).toMatch(/applySessionToolPolicy\(\{[^}]*scopeDeniedTools: execution\.scopeDeniedTools,/);
  });
});
