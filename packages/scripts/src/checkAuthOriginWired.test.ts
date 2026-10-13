import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards ToolContext.authOrigin: every door that runs tools must state how its turn was
 * authenticated, because a tool that refuses non-session turns fails closed on anything but an
 * explicit `session`. Doors kept shipping without the old implicit signal (a missing `apiKeyId`
 * read as a session), and nothing failed.
 *
 * Typecheck already requires the field on ToolContext, the tool-builder deps, invoke() and the
 * quest-start body. This catches what typecheck cannot: a door whose deps object is `any` (the
 * CLI's), or a new file that reaches tools some other way. File-level on purpose - the argument is
 * often a variable built further up - so a door file must name `authOrigin` or derive it through
 * `requestTurnAuth` / `executionTurnAuth` (apps/client/server/auth/turnAuth.ts).
 *
 * `packages/premium/*` is excluded for the same reason as checkToolAvailabilityWired.test.ts: those
 * overlays are hydrated private checkouts that exist only on a developer box.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SEARCH_DIRS = 'apps b4m-core packages';
const EXCLUDES = '--exclude-dir=premium --exclude-dir=node_modules --exclude-dir=dist';

/** Builds a tool context or a tool set directly. */
const TOOL_BUILD_SITE = /\b(?:buildSharedTools|generateTools)\(\s*[^)\s]|\bnew ToolBuilder\(|:\s*ToolContext\s*=\s*\{/;
/** Runs a chat turn (and so its tools) through the chat-completion services. */
const COMPLETION_SERVICE = /\bChatCompletion(?:Invoke|Process)\b/;
const COMPLETION_CALL = /\.(?:invoke|process)\(\s*\{/;
const STATES_AUTH = /\bauthOrigin\b|\b(?:request|execution)TurnAuth\(/;

/**
 * Door files that forward an authOrigin decided upstream, so they never name it. Add an entry only
 * with a reason - an exemption here is permanent and silent.
 */
const FORWARDERS = new Map<string, string>([
  [
    'apps/client/server/queueHandlers/questProcessor.ts',
    'Runs the queued quest-start body as-is; the invoke() that queued it set authOrigin.',
  ],
  [
    'apps/client/server/queueHandlers/slackQuestProcessor.ts',
    'Runs the queued quest-start body as-is; the Slack invoke() that queued it set authOrigin.',
  ],
  [
    'apps/client/server/queueHandlers/agentExecutor.latticeTools.ts',
    "Spreads the executor's own ToolBuilderDeps, whose authOrigin is required by type.",
  ],
]);

/** Drops comments so a door named only in prose (or a doc example) is neither a match nor a pass. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function isDoor(code: string): boolean {
  return TOOL_BUILD_SITE.test(code) || (COMPLETION_SERVICE.test(code) && COMPLETION_CALL.test(code));
}

describe('every door that runs tools states its authOrigin', () => {
  it('has no door file that leaves the turn auth implicit', () => {
    const out = execSync(
      `grep -rlE "buildSharedTools|generateTools|ToolBuilder|ToolContext|ChatCompletionInvoke|ChatCompletionProcess" ` +
        `--include="*.ts" ${EXCLUDES} ${SEARCH_DIRS} | grep -v "\\.test\\.ts$" || true`,
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    const doors = out
      .split('\n')
      .filter(Boolean)
      .map(file => ({ file, code: stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8')) }))
      .filter(({ code }) => isDoor(code));
    // Fail loudly rather than vacuously passing if the patterns ever stop matching the tree.
    expect(doors.length, `expected tool-running doors under ${SEARCH_DIRS}`).toBeGreaterThan(10);

    const unwired = doors
      .filter(({ file, code }) => !FORWARDERS.has(file) && !STATES_AUTH.test(code))
      .map(({ file }) => file);

    expect(
      unwired,
      "Set authOrigin ('session' | 'apiKey' | 'internal') where this file builds tools or calls " +
        'invoke()/process(), via requestTurnAuth(req) for a request behind the API auth middleware, ' +
        'or add the file to FORWARDERS with a reason.'
    ).toEqual([]);
  });

  it('keeps every forwarder a real door, so a stale exemption does not linger', () => {
    for (const file of FORWARDERS.keys()) {
      const code = stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      expect(isDoor(code), `${file} is no longer a door; drop it from FORWARDERS`).toBe(true);
    }
  });

  it('flags a door that leaves the turn auth implicit, and passes one that states it', () => {
    const door = `const toolDeps: ToolBuilderDeps = { userId };\nbuildSharedTools(toolDeps, callbacks, {});`;
    expect(isDoor(stripComments(door))).toBe(true);
    expect(STATES_AUTH.test(stripComments(door))).toBe(false);
    expect(STATES_AUTH.test(stripComments(door.replace('{ userId }', "{ userId, authOrigin: 'internal' }")))).toBe(
      true
    );
    // Prose naming the field does not satisfy the guard.
    expect(STATES_AUTH.test(stripComments(`${door}\n// authOrigin is set upstream`))).toBe(false);
  });
});
