import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards #2960: MCP tools merged by `buildSharedTools` are unreachable from its returned array
 * (they're captured by the delegate tool's closure, or - for an offered, non-agent-only tool -
 * still present but a caller's own post-build denylist pass runs on a list that omits agent-only
 * MCP tools entirely). `sessionDisabledTools` is the only lever inside `buildSharedTools` itself
 * that can subtract an MCP tool by name, so any call site that hands it `mcpToolsByServer` (i.e.
 * MCP tools can actually reach the model there) must also hand it `sessionDisabledTools`, or a
 * session-forbidden MCP tool stays callable through that site.
 *
 * Static because the two `agentExecutor.ts` sites live inside `processExecution` /
 * `dispatchSubagent`, which have no test harness - same rationale as
 * checkToolAvailabilityWired.test.ts for the equivalent `toolAvailability` gap (#1607). The pure
 * gating logic itself is covered by sharedToolBuilder.mcpNarrowing.test.ts; this only proves each
 * production call site still passes the option.
 *
 * Scoped to the open-source tree on purpose: `packages/premium/*` is a set of hydrated private
 * overlays that exist only on a developer box, so including them would make this pass in CI and
 * fail locally.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SEARCH_DIRS = 'apps b4m-core packages';
const EXCLUDES = '--exclude-dir=premium --exclude-dir=node_modules --exclude-dir=dist';

/**
 * Call sites that legitimately pass `mcpToolsByServer` without `sessionDisabledTools`. Empty on
 * purpose - every current site wires both together. Add an entry only with a reason: an exemption
 * here means a session denylist cannot reach an MCP tool offered through that site.
 */
const ALLOWLIST = new Map<string, string>();

/** Extract each `buildSharedTools(` call's full argument text by balancing parentheses. */
function callArgumentTexts(source: string): string[] {
  const calls: string[] = [];
  const needle = 'buildSharedTools(';
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    // Skip only the declaration itself and prose - see checkToolAvailabilityWired.test.ts for why
    // there's deliberately no import/export skip here too.
    const lineStart = source.lastIndexOf('\n', i) + 1;
    const line = source.slice(lineStart, source.indexOf('\n', i));
    const beforeCall = source.slice(lineStart, i);
    if (/\bfunction\s+$/.test(beforeCall)) continue;
    if (/^\s*(\*|\/\/)/.test(line)) continue;
    if (source.startsWith('buildSharedTools()', i)) continue;

    let depth = 0;
    let end = i + needle.length - 1;
    for (let j = i + needle.length - 1; j < source.length; j++) {
      if (source[j] === '(') depth++;
      else if (source[j] === ')') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    calls.push(source.slice(i, end + 1));
  }
  return calls;
}

describe('every buildSharedTools call offering MCP tools also passes sessionDisabledTools', () => {
  it('has no call site that offers mcpToolsByServer without the MCP denylist', () => {
    const out = execSync(
      `grep -rl "buildSharedTools(" --include="*.ts" ${EXCLUDES} ${SEARCH_DIRS} | grep -v "\\.test\\.ts$" || true`,
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const files = out.split('\n').filter(Boolean);
    expect(files.length, `expected buildSharedTools call sites under ${SEARCH_DIRS}`).toBeGreaterThan(0);

    const unwired = files.flatMap(file => {
      if (ALLOWLIST.has(file)) return [];
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      return callArgumentTexts(source)
        .filter(call => call.includes('mcpToolsByServer') && !call.includes('sessionDisabledTools'))
        .map(() => file);
    });

    expect(
      unwired,
      'Pass sessionDisabledTools alongside mcpToolsByServer, or add the file to ALLOWLIST with a reason - ' +
        'otherwise a session-forbidden MCP tool stays reachable through this call site.'
    ).toEqual([]);
  });
});
