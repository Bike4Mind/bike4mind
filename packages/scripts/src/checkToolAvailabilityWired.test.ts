import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards #1607: every `buildSharedTools(...)` call must pass `toolAvailability`, so a tool the
 * caller enabled but has no working key/config for is dropped from the schema sent to the model
 * instead of reaching it and throwing at call time. The option is optional by design (omitting it
 * means "offer everything unfiltered"), which is exactly why a new call site can silently reopen
 * the gap - #1103 shipped with 2 of 6 sites wired and nothing flagged the other 4.
 *
 * Static because the two `agentExecutor.ts` sites live inside `processExecution` /
 * `dispatchSubagent`, which have no test harness; the filter's behavior is covered by
 * apps/client/server/queueHandlers/agentExecutor.toolAvailability.test.ts and
 * apps/client/server/deepAgent/toolMaterializer.test.ts.
 *
 * Scoped to the open-source tree on purpose: `packages/premium/*` is a set of hydrated private
 * overlays that exist only on a developer box, so including them would make this pass in CI and
 * fail locally.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// The whole tree, so a call site added in a package nobody thought of is still caught - that is the
// entire point of this guard. `premium` is excluded because those overlays are hydrated private
// checkouts that exist only on a developer box: including them makes the check pass in CI and fail
// locally (the precedent `checkNoRawS3Client.test.ts` greps `packages` unscoped and does exactly
// that today).
const SEARCH_DIRS = 'apps b4m-core packages';
const EXCLUDES = '--exclude-dir=premium --exclude-dir=node_modules --exclude-dir=dist';

/**
 * Call sites that legitimately pass no availability map. Empty on purpose: every current site,
 * including the chat path's `ToolBuilder.ts` wrapper, passes the option by name. Add an entry only
 * with a reason - an exemption here is permanent and silent.
 */
const ALLOWLIST = new Map<string, string>();

/** Extract each `buildSharedTools(` call's full argument text by balancing parentheses. */
function callArgumentTexts(source: string): string[] {
  const calls: string[] = [];
  const needle = 'buildSharedTools(';
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    // Skip the declaration itself, import/re-export mentions, and prose (these modules cite
    // `buildSharedTools()` in doc comments, a zero-arg match no real call produces). Matched against
    // the text BEFORE the call only: testing the whole line would skip a real call site that merely
    // happens to sit on one, e.g. `export const tools = buildSharedTools({...})`.
    const lineStart = source.lastIndexOf('\n', i) + 1;
    const line = source.slice(lineStart, source.indexOf('\n', i));
    const beforeCall = source.slice(lineStart, i);
    if (/\bfunction\s+$/.test(beforeCall)) continue;
    if (/^\s*(import|export)\b[^=]*$/.test(beforeCall)) continue;
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

describe('every buildSharedTools call passes toolAvailability', () => {
  it('has no call site that skips the key-availability filter', () => {
    const out = execSync(
      `grep -rl "buildSharedTools(" --include="*.ts" ${EXCLUDES} ${SEARCH_DIRS} | grep -v "\\.test\\.ts$" || true`,
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const files = out.split('\n').filter(Boolean);
    // Fail loudly rather than vacuously passing if the grep scope ever stops matching the tree.
    expect(files.length, `expected buildSharedTools call sites under ${SEARCH_DIRS}`).toBeGreaterThan(0);

    const unwired = files.flatMap(file => {
      if (ALLOWLIST.has(file)) return [];
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      return callArgumentTexts(source)
        .filter(call => !call.includes('toolAvailability'))
        .map(() => file);
    });

    expect(
      unwired,
      'Resolve availability with resolveToolAvailability(userId, { db }, { onLookupError: "unavailable", logger }) ' +
        "and pass it as buildSharedTools' toolAvailability option, or add the file to ALLOWLIST with a reason."
    ).toEqual([]);
  });
});
