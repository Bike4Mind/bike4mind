import { describe, expect, it } from 'vitest';
import type { ChatToolCall } from '@shared/chat';
import { GhError } from './gh';
import { PrMonitor } from './PrMonitor';
import { REF, collector, fakeGithub, quietLogger, snapshot, tempStore } from './prTestSupport';

const SESSION = 'session-1';

function shellCall(command: string, preview: string, status: ChatToolCall['status'] = 'done'): ChatToolCall {
  return { id: 'c1', name: 'bash_execute', input: { command }, status, preview };
}

function setup(project: { workingDirectory: string; branch: string | null } | null = null) {
  const store = tempStore();
  const fake = fakeGithub();
  const out = collector();
  const monitor = new PrMonitor({
    store,
    github: fake.github,
    chat: { project: async () => project, archive: async () => undefined },
    emit: out.emit,
    logger: quietLogger,
  });
  return { store, fake, out, monitor };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('PrMonitor binding', () => {
  it('binds from gh pr create output and reads the PR once', async () => {
    const { store, fake, out, monitor } = setup();
    monitor.observeToolEnd(SESSION, shellCall('gh pr create --fill', `${REF.url}\n`));
    await settle();
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
    await settle();
    expect(await store.get(SESSION)).toBeNull();
  });

  it('lets a manual bind replace a detected one, and refuses a bad URL', async () => {
    const { store, monitor } = setup();
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', REF.url));
    await settle();
    expect(await monitor.bindManual(SESSION, 'not a url')).toEqual({ ok: false, error: expect.any(String) });
    expect(await monitor.bindManual(SESSION, 'https://github.com/example-org/widgets/pull/700')).toEqual({ ok: true });
    expect(await store.get(SESSION)).toMatchObject({ number: 700, source: 'manual' });
  });

  it('does not let a detection replace a PR that has automation armed', async () => {
    const { store, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'manual', boundAt: '', autoArchive: true });
    monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
    await settle();
    expect(await store.get(SESSION)).toMatchObject({ number: 611 });
  });

  it('keeps a dismissed PR hidden when it is detected again, and a manual bind brings it back', async () => {
    const { store, out, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    expect(await monitor.dismiss(SESSION)).toEqual({ ok: true });
    expect(out.last()?.binding).toBeNull();
    monitor.observeToolEnd(SESSION, shellCall('git push', `remote:   ${REF.url}`));
    await settle();
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
    await settle();
    expect(onMain.fake.calls).toEqual([]);

    const onFeature = setup({ workingDirectory: '/work', branch: 'feat/widget-ladder' });
    await onFeature.monitor.watch(1, SESSION);
    await onFeature.monitor.watch(1, SESSION);
    await settle();
    expect(onFeature.fake.calls).toEqual(['branch:feat/widget-ladder']);
  });

  it('shows a missing gh as app-wide state rather than an error per PR', async () => {
    const { store, fake, out, monitor } = setup();
    await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
    fake.answer(new GhError('missing', 'gh is not installed'));
    await monitor.watch(1, SESSION);
    await settle();
    expect(out.last()).toMatchObject({ gh: 'missing', binding: { number: 611 } });
    fake.answer(snapshot());
    await monitor.refresh(SESSION);
    expect(out.last()).toMatchObject({ gh: 'ok', snapshot: { number: 611 } });
  });
});
