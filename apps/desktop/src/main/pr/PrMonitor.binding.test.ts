import { describe, expect, it } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import { GhError } from './gh';
import type { PrChatHooks } from './PrMonitor';
import { REF, TrackedMonitor, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';

function shellCall(command: string, preview: string, status: ChatToolCall['status'] = 'done'): ChatToolCall {
  return { id: 'c1', name: 'bash_execute', input: { command }, status, preview };
}

type Project = { workingDirectory: string; branch: string | null } | null;

function setup(project: Project | PrChatHooks['project'] = null, code = true) {
  const store = tempStore();
  const fake = fakeGithub();
  const out = collector();
  const monitor = new TrackedMonitor({
    store,
    github: fake.github,
    chat: {
      isCode: async () => code,
      project: typeof project === 'function' ? project : async () => project,
      archive: async () => undefined,
      isBusy: () => false,
      startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
    },
    emit: out.emit,
    logger: quietLogger,
    batchWindowMs: 0,
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

  it.each(['manual', 'agent'] as const)('does not let a detection replace a PR the %s bind chose', async source => {
    const { store, monitor } = setup();
    await store.set(SESSION, { ...REF, source, boundAt: '', lastState: 'OPEN' });
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 611, source });
  });

  it('lets a detection replace a chosen PR once it is merged, or once it is cleared', async () => {
    const { store, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'agent', boundAt: '', lastState: 'MERGED' });
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 700, source: 'shell' });

    await store.set(SESSION, { ...REF, source: 'agent', boundAt: '' });
    await monitor.dismiss(SESSION);
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/701'));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 701, source: 'shell' });
    monitor.dispose();
  });

  it('reads a chosen PR saved before this launch, and lets a detection replace it if it merged since', async () => {
    const { store, fake, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'manual', boundAt: '', lastState: 'OPEN' });
    fake.answer(snapshot({ state: 'MERGED' }));
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 700, source: 'shell' });
    monitor.dispose();
  });

  it('does not let a chosen PR that was not found hold off a detection', async () => {
    const { store, fake, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'agent', boundAt: '' });
    fake.answer(new GhError('not-found', '#611 was not found in example-org/widgets'));
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 700, source: 'shell' });
    monitor.dispose();
  });

  it('keeps a chosen PR when the read fails for another reason', async () => {
    const { store, fake, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'agent', boundAt: '' });
    fake.answer(new GhError('failed', 'network down'));
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'agent' });
    monitor.dispose();
  });

  it('lets an explicit bind replace a PR the user chose', async () => {
    const { store, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'manual', boundAt: '', lastState: 'OPEN' });
    expect(await monitor.bindForAgent(SESSION, '#700')).toMatchObject({ ok: true, pr: { number: 700 } });
    expect(await store.get(SESSION)).toMatchObject({ number: 700, source: 'agent' });
    await monitor.idle();
    monitor.dispose();
  });

  it('pins a detected PR the agent confirms, keeping its options', async () => {
    const { store, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '', autoFix: true });
    expect(await monitor.bindForAgent(SESSION, REF.url)).toMatchObject({ ok: true, pr: { number: 611 } });
    expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'agent', autoFix: true });
    await store.update(SESSION, current => ({ ...current, autoFix: false }));
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await monitor.idle();
    expect(await store.get(SESSION)).toMatchObject({ number: 611 });
  });

  it('keeps a dismissed PR hidden when it is detected again, and a manual bind brings it back', async () => {
    const { store, out, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    expect(await monitor.dismiss(SESSION)).toEqual({ ok: true });
    expect(out.last()?.binding).toBeNull();
    expect(out.last()?.dismissed).toBe(true);
    monitor.observeToolEnd(SESSION, shellCall('git push', `remote:   ${REF.url}`));
    await monitor.idle();
    expect((await store.get(SESSION))?.dismissed).toBe(true);
    await monitor.bindManual(SESSION, REF.url);
    await monitor.idle();
    expect((await store.get(SESSION))?.dismissed).toBe(false);
    expect(out.last()?.dismissed).toBeUndefined();
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

  describe('a binding command whose output lost the PR URL', () => {
    const command =
      "git push -u origin feat/widget-ladder && gh pr create --base main --head feat/widget-ladder --body-file - <<'EOF'";
    const cut = [
      `$ ${command}`,
      '(in /work)',
      '',
      'pre-push hook: checking',
      '[... 163226 bytes omitted from the middle ...]',
      'pre-push hook: done',
      '',
      '[exit 0]',
    ].join('\n');

    it('looks up the branch at once and binds its PR', async () => {
      const asked: unknown[] = [];
      const { store, fake, monitor } = setup(async (_id, options) => {
        asked.push(options);
        return { workingDirectory: '/work', branch: 'feat/widget-ladder' };
      });
      fake.answerBranch(REF.url);

      monitor.observeToolEnd(SESSION, shellCall(command, cut));
      await monitor.idle();

      expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'branch' });
      expect(fake.calls).toEqual(['branch:feat/widget-ladder', 'snapshot']);
      expect(asked).toEqual([{ live: true }]);
      monitor.dispose();
    });

    it('asks again past the lookup made when the conversation was opened', async () => {
      const { store, fake, monitor } = setup({ workingDirectory: '/work', branch: 'feat/widget-ladder' });
      await monitor.watch(1, SESSION);
      await monitor.idle();
      fake.answerBranch(REF.url);

      monitor.observeToolEnd(SESSION, shellCall(command, cut));
      await monitor.idle();

      expect(await store.get(SESSION)).toMatchObject({ number: 611, source: 'branch' });
      expect(fake.calls.filter(call => call.startsWith('branch:'))).toHaveLength(2);
      monitor.dispose();
    });

    it('makes no gh call for a failed or ordinary command, an unowned branch, or a bound open PR', async () => {
      const onFeature = setup({ workingDirectory: '/work', branch: 'feat/widget-ladder' });
      onFeature.monitor.observeToolEnd(SESSION, shellCall(command, cut.replace('[exit 0]', '[exit 1]')));
      onFeature.monitor.observeToolEnd(SESSION, shellCall('ls -la', '$ ls -la\n\n[exit 0]'));
      await onFeature.monitor.idle();
      expect(onFeature.fake.calls).toEqual([]);

      await onFeature.store.set(SESSION, { ...REF, source: 'shell', boundAt: '', lastState: 'OPEN' });
      onFeature.monitor.observeToolEnd(SESSION, shellCall('git push', '$ git push\n\n[exit 0]'));
      await onFeature.monitor.idle();
      expect(onFeature.fake.calls).toEqual([]);
      onFeature.monitor.dispose();

      const onMain = setup({ workingDirectory: '/work', branch: 'main' });
      onMain.monitor.observeToolEnd(SESSION, shellCall(command, cut));
      await onMain.monitor.idle();
      expect(onMain.fake.calls).toEqual([]);
    });

    it('binds a follow-up PR over a merged one, but keeps a dismissed open one hidden', async () => {
      const followUp = { ...REF, number: 612, url: 'https://github.com/example-org/widgets/pull/612' };
      const merged = setup({ workingDirectory: '/work', branch: 'feat/widget-ladder' });
      await merged.store.set(SESSION, { ...REF, source: 'shell', boundAt: '', lastState: 'MERGED' });
      merged.fake.answerBranch(followUp.url);
      merged.monitor.observeToolEnd(SESSION, shellCall(command, cut));
      await merged.monitor.idle();
      expect(await merged.store.get(SESSION)).toMatchObject({ number: 612, source: 'branch' });
      merged.monitor.dispose();

      const dismissed = setup({ workingDirectory: '/work', branch: 'feat/widget-ladder' });
      await dismissed.store.set(SESSION, { ...REF, source: 'shell', boundAt: '', dismissed: true, lastState: 'OPEN' });
      dismissed.fake.answerBranch(REF.url);
      dismissed.monitor.observeToolEnd(SESSION, shellCall(command, cut));
      await dismissed.monitor.idle();
      expect(await dismissed.store.get(SESSION)).toMatchObject({ number: 611, dismissed: true });
      expect(dismissed.fake.calls).toEqual([]);
    });
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
