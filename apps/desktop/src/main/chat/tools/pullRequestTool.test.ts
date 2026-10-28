import { describe, expect, it } from 'vitest';
import type { PrSummaryEvent } from '@shared/pullRequest';
import { REF, TrackedMonitor, collector, fakeGithub, quietLogger, tempStore } from '../../pr/prTestSupport';
import { setSessionPullRequest } from './pullRequestTool';
import { findTool, toolsForRequest } from './registry';
import type { ToolContext } from './types';

const SESSION = 'session-1';
const OTHER_URL = 'https://github.com/example-org/widgets/pull/700';

function setup(code = true) {
  const store = tempStore();
  const fake = fakeGithub();
  const out = collector();
  const pushed: PrSummaryEvent[] = [];
  const monitor = new TrackedMonitor({
    store,
    github: fake.github,
    chat: {
      isCode: async () => code,
      project: async () => null,
      archive: async () => undefined,
      isBusy: () => false,
      startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
    },
    emit: out.emit,
    emitSummary: event => pushed.push(event),
    logger: quietLogger,
    batchWindowMs: 0,
  });
  const labels: string[] = [];
  // Scoped the way ChatService scopes it: the session comes from the call, never the arguments.
  const context = {
    roots: [],
    signal: new AbortController().signal,
    sessionId: SESSION,
    pullRequests: {
      bind: (target: string) => monitor.bindForAgent(SESSION, target),
      clear: () => monitor.dismiss(SESSION),
    },
    report: { label: (text: string) => labels.push(text) },
  } as unknown as ToolContext;
  const run = (input: Record<string, unknown>) => setSessionPullRequest.run(input, context);
  return { store, fake, out, pushed, monitor, run, labels };
}

describe('set_session_pull_request', () => {
  it('binds a URL, names it in the result and the row, and pushes the sidebar icon', async () => {
    const { store, fake, out, pushed, monitor, run, labels } = setup();
    expect(await run({ pull_request: REF.url })).toBe(
      `The session's pull request is now example-org/widgets#611 (${REF.url}).`
    );
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'agent' });
    expect(labels).toEqual(["Set the session's PR to example-org/widgets#611"]);
    expect(out.last()).toMatchObject({ sessionId: SESSION, binding: { number: 611 } });
    expect(pushed).toEqual([{ sessionId: SESSION, summary: { number: 611, state: 'open' } }]);
    expect(fake.calls).toEqual(['snapshot']);
    monitor.dispose();
  });

  it('replaces a detected PR, resolving #N in its repo', async () => {
    const { store, pushed, monitor, run } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    expect(await run({ pull_request: '#700' })).toContain('example-org/widgets#700');
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 700, source: 'agent' });
    expect(pushed.at(-1)).toEqual({ sessionId: SESSION, summary: { number: 700, state: 'open' } });
    monitor.dispose();
  });

  it('refuses in a Chat conversation', async () => {
    const { store, fake, run } = setup(false);
    await expect(run({ pull_request: REF.url })).rejects.toThrow(
      'Pull requests can only be added to a Code conversation.'
    );
    expect(await store.get(SESSION)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it('refuses a bad URL, and a bare number with nothing bound to resolve it in', async () => {
    const { store, run } = setup();
    await expect(run({ pull_request: 'https://github.com/example-org/widgets/issues/9' })).rejects.toThrow(
      'That is not a GitHub pull request URL, owner/repo#N, or #N.'
    );
    await expect(run({ pull_request: '#9' })).rejects.toThrow(/No pull request is bound yet/);
    expect(await store.get(SESSION)).toBeNull();
  });

  it('refuses while auto-merge is armed on a different PR, and binds that same PR', async () => {
    const { store, monitor, run } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '', autoMerge: true });
    await expect(run({ pull_request: OTHER_URL })).rejects.toThrow(
      'Turn off auto-merge on #611 before binding another PR.'
    );
    expect(await store.get(SESSION)).toMatchObject({ number: 611, autoMerge: true });
    expect(await run({ pull_request: REF.url })).toContain('#611');
    await monitor.idle();
    monitor.dispose();
  });

  it('clears through dismiss, keeping the sidebar icon, and a later bind brings the bar back', async () => {
    const { store, out, pushed, monitor, run, labels } = setup();
    await run({ pull_request: REF.url });
    await monitor.idle();
    expect(await run({ clear: true })).toBe("Cleared the session's pull request; the PR bar is closed.");
    expect(await store.get(SESSION)).toMatchObject({ number: 611, dismissed: true });
    expect(out.last()?.binding).toBeNull();
    expect(labels.at(-1)).toBe("Cleared the session's PR");
    // A dismissed bar keeps its icon; see PrMonitor.summaryOf.
    expect(pushed).toEqual([{ sessionId: SESSION, summary: { number: 611, state: 'open' } }]);

    await run({ pull_request: REF.url });
    await monitor.idle();
    expect((await store.get(SESSION))?.dismissed).toBe(false);
    monitor.dispose();
  });

  it('refuses to clear while auto-merge is armed', async () => {
    const { store, run } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '', autoMerge: true });
    await expect(run({ clear: true })).rejects.toThrow('Turn off auto-merge before closing this bar.');
  });

  it('asks for exactly one of pull_request and clear', async () => {
    const { run } = setup();
    await expect(run({})).rejects.toThrow('Pass pull_request, or clear: true.');
    await expect(run({ pull_request: REF.url, clear: true })).rejects.toThrow(/not both/);
  });

  it('refuses without a PR monitor', async () => {
    await expect(
      setSessionPullRequest.run({ pull_request: REF.url }, { roots: [], signal: new AbortController().signal })
    ).rejects.toThrow('The PR bar can only be changed in a conversation the user is in.');
  });

  it('is offered only to a Code session with a user present', () => {
    const names = (options: Partial<Parameters<typeof toolsForRequest>[0]>) =>
      toolsForRequest({ roots: [], media: false, host: false, ...options }).map(entry => entry.toolSchema.name);
    expect(names({ pullRequest: true, ask: true })).toContain('set_session_pull_request');
    expect(names({ pullRequest: true, ask: false })).not.toContain('set_session_pull_request');
    expect(names({ pullRequest: false, ask: true })).not.toContain('set_session_pull_request');
    expect(findTool('set_session_pull_request')).toBe(setSessionPullRequest);
    expect(setSessionPullRequest.approval).toBeUndefined();
  });
});
