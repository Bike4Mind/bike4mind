import { describe, expect, it } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import { GhError } from './gh';
import { REF, TrackedMonitor, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';

function shellCall(command: string, preview: string, status: ChatToolCall['status'] = 'done'): ChatToolCall {
  return { id: 'c1', name: 'bash_execute', input: { command }, status, preview };
}

/** Timers the test fires by hand. */
function manualTimers() {
  const pending: { callback: () => void; ms: number }[] = [];
  return {
    pending,
    timers: {
      set: (callback: () => void, ms: number) => pending.push({ callback, ms }),
      clear: () => undefined,
    },
  };
}

function setup(
  project: { workingDirectory: string; branch: string | null } | null = null,
  code = true,
  timers = manualTimers().timers
) {
  const store = tempStore();
  const fake = fakeGithub();
  const out = collector();
  const monitor = new TrackedMonitor({
    store,
    github: fake.github,
    chat: {
      isCode: async () => code,
      project: async () => project,
      archive: async () => undefined,
      isBusy: () => false,
      startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
    },
    emit: out.emit,
    logger: quietLogger,
    batchWindowMs: 0,
    timers,
  });
  return { store, fake, out, monitor };
}

describe('PrMonitor binding', () => {
  it('binds from gh pr create output and reads the PR once', async () => {
    const { store, fake, out, monitor } = setup();
    monitor.observeToolEnd(SESSION, shellCall('gh pr create --fill', `${REF.url}\n`));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'shell' });
    expect(fake.calls).toEqual(['snapshot']);
    expect(out.last()).toMatchObject({ binding: { number: 611 }, snapshot: { additions: 157 }, gh: 'ok' });
    monitor.dispose();
  });

  it('ignores a failed command and a non-shell tool', async () => {
    const { store, monitor } = setup();
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', REF.url, 'error'));
    monitor.observeToolEnd(SESSION, {
      id: 'c2',
      name: 'file_read',
      input: { command: 'gh pr create' },
      status: 'done',
      preview: REF.url,
    });
    await monitor.idle();
    expect(await store.get(SESSION)).toBeNull();
  });

  it('lets a manual bind replace a detected one, and refuses a bad URL', async () => {
    const { store, monitor } = setup();
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', REF.url));
    await monitor.idle();
    expect(await monitor.bindManual(SESSION, 'not a url')).toEqual({ ok: false, error: expect.any(String) });
    expect(await monitor.bindManual(SESSION, 'https://github.com/example-org/widgets/pull/700')).toEqual({ ok: true });
    expect(await store.get(SESSION)).toMatchObject({ number: 700, source: 'manual' });
  });

  it('refuses a pasted PR in a Chat conversation', async () => {
    const { store, fake, monitor } = setup(null, false);
    expect(await monitor.bindManual(SESSION, REF.url)).toEqual({
      ok: false,
      error: 'Pull requests can only be added to a Code conversation.',
    });
    expect(await store.get(SESSION)).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it('does not let a detection replace a PR that has automation armed', async () => {
    const { store, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'manual', boundAt: '', autoArchive: true });
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 611 });
  });

  it('keeps a dismissed PR hidden when it is detected again, and a manual bind brings it back', async () => {
    const { store, out, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    expect(await monitor.dismiss(SESSION)).toEqual({ ok: true });
    expect(out.last()?.binding).toBeNull();
    monitor.observeToolEnd(SESSION, shellCall('git push', `remote:   ${REF.url}`));
    await monitor.idle();
    expect((await store.get(SESSION))?.dismissed).toBe(true);
    await monitor.bindManual(SESSION, REF.url);
    expect((await store.get(SESSION))?.dismissed).toBe(false);
  });

  it('refuses to dismiss while auto-merge is armed', async () => {
    const { store, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '', autoMerge: true });
    expect(await monitor.dismiss(SESSION)).toMatchObject({ ok: false });
  });

  it('looks up the branch PR only when a code session is opened, skipping main', async () => {
    const onMain = setup({ workingDirectory: '/work', branch: 'main' });
    await onMain.monitor.watch(1, SESSION);
    await onMain.monitor.idle();
    expect(onMain.fake.calls).toEqual([]);

    const onFeature = setup({ workingDirectory: '/work', branch: 'feat/widget-ladder' });
    await onFeature.monitor.watch(1, SESSION);
    await onFeature.monitor.watch(1, SESSION);
    await onFeature.monitor.idle();
    expect(onFeature.fake.calls).toEqual(['branch:feat/widget-ladder']);
  });

  it('binds from a URL the shell tool cut from the preview of a long push', async () => {
    const { store, fake, monitor } = setup({ workingDirectory: '/work', branch: 'feat/widget-ladder' });
    const command =
      'git push -u origin feat/widget-ladder && gh pr create --base main --head feat/widget-ladder --title t --body-file b';
    const preview = [
      `$ ${command}`,
      'turbo build output...',
      '[truncated: 121490 more bytes]',
      '',
      '[stderr]',
      'remote: Create a pull request for feat/widget-ladder on GitHub by visiting:',
      'remote:   https://github.com/example-org/widgets/pull/new/feat/widget-ladder',
    ].join('\n');
    monitor.observeToolEnd(SESSION, shellCall(command, preview), `...build done\n${REF.url}\n`);
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'shell' });
    expect(fake.calls).toEqual(['snapshot']);
    monitor.dispose();
  });

  it('looks up the branch at once when a push or create shows no URL, despite a recent lookup', async () => {
    const { store, fake, monitor } = setup({ workingDirectory: '/work', branch: 'feat/widget-ladder' });
    await monitor.watch(1, SESSION);
    await monitor.idle();
    fake.branchAnswers(REF.url);
    monitor.observeToolEnd(SESSION, shellCall('git push -u origin feat/widget-ladder', 'Everything up-to-date'));
    await monitor.idle();
    expect(fake.calls).toEqual(['branch:feat/widget-ladder', 'branch:feat/widget-ladder', 'snapshot']);
    expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'branch' });
    monitor.dispose();
  });

  it('asks once more shortly after gh pr create when GitHub does not list the PR yet', async () => {
    const clock = manualTimers();
    const { store, fake, monitor } = setup(
      { workingDirectory: '/work', branch: 'feat/widget-ladder' },
      true,
      clock.timers
    );
    fake.branchAnswers(null, REF.url);
    monitor.observeToolEnd(SESSION, shellCall('gh pr create --fill', 'Creating pull request...'));
    await monitor.idle();
    expect(await store.get(SESSION)).toBeNull();
    expect(clock.pending.map(timer => timer.ms)).toEqual([5_000]);
    clock.pending.shift()?.callback();
    await monitor.idle();
    expect(fake.calls).toEqual(['branch:feat/widget-ladder', 'branch:feat/widget-ladder', 'snapshot']);
    expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'branch' });
    monitor.dispose();
  });

  it('does not look up after a push in a conversation that already has a PR, nor retry after a plain push', async () => {
    const clock = manualTimers();
    const { store, fake, monitor } = setup(
      { workingDirectory: '/work', branch: 'feat/widget-ladder' },
      true,
      clock.timers
    );
    monitor.observeToolEnd(SESSION, shellCall('git push', 'Everything up-to-date'));
    await monitor.idle();
    expect(fake.calls).toEqual(['branch:feat/widget-ladder']);
    expect(clock.pending).toEqual([]);

    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    fake.calls.length = 0;
    monitor.observeToolEnd(SESSION, shellCall('gh pr create --fill', 'Creating pull request...'));
    await monitor.idle();
    expect(fake.calls).toEqual([]);
    monitor.dispose();
  });

  it('looks a renamed branch up again on the next open, despite the quiet spell', async () => {
    const project = { workingDirectory: '/work', branch: 'agent/first-name' };
    const { fake, monitor } = setup(project);
    await monitor.watch(1, SESSION);
    await monitor.idle();
    project.branch = 'fix/renamed';
    monitor.observeToolEnd(SESSION, shellCall('git branch -m fix/renamed', ''));
    await monitor.watch(1, SESSION);
    await monitor.idle();
    expect(fake.calls).toEqual(['branch:agent/first-name', 'branch:fix/renamed']);
    monitor.dispose();
  });

  it('shows a missing gh as app-wide state rather than an error per PR', async () => {
    const { store, fake, out, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    fake.answer(new GhError('missing', 'gh is not installed'));
    await monitor.watch(1, SESSION);
    await monitor.idle();
    expect(out.last()).toMatchObject({ gh: 'missing', binding: { number: 611 } });
    fake.answer(snapshot());
    await monitor.refresh(SESSION);
    expect(out.last()).toMatchObject({ gh: 'ok', snapshot: { number: 611 } });
  });
});
