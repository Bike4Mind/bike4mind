import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { GhError, classifyGhFailure } from './gh';
import { REF, TrackedMonitor, collector, fakeGithub, quietLogger, snapshot, tempStore, check } from './prTestSupport';
import { POLL_MS, alignToTick, pollDelay, type PollInput } from './pollSchedule';
import { DEFAULT_AUTO_FIX_ATTEMPTS } from '@shared/autoFixSetting';
import { desktopMergeReadiness } from './autoMerge';
import { PrMonitor, type PrChatHooks, type PrTimers, type PrMonitorDeps } from './PrMonitor';
import { shouldAutoArchive } from './autoArchive';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrBindingStore } from './PrBindingStore';
import { autoFixRefusal, autoFixToolRefusal, planAutoFix } from './autoFix';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { IPC_CHANNELS } from '@shared/ipc';
import { AutoFixAttemptsPreference } from './AutoFixAttemptsPreference';
import { registerAutoFixAttemptsIpc } from './autoFixAttemptsIpc';
import {
  countChecks,
  type PrSummaryEvent,
  type PrBinding,
  type PrSnapshot,
  type PrChangeRequest,
  type PrReviewThread,
  type PrRef,
} from '@shared/pullRequest';
import { PrGithub, batchQuery, latestCheckRuns, mergeMethodFor, parseSnapshot } from './github';
import type { ChatToolCall, ChatAutomaticOrigin } from '@shared/chat';

describe('binding', () => {
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
      expect(await monitor.bindManual(SESSION, 'https://github.com/example-org/widgets/pull/700')).toEqual({
        ok: true,
      });
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
        await dismissed.store.set(SESSION, {
          ...REF,
          source: 'shell',
          boundAt: '',
          dismissed: true,
          lastState: 'OPEN',
        });
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
});

describe('polling', () => {
  const SESSION = 'session-1';

  /** Timers the test fires by hand. Only the latest per session matters, as in the monitor. */
  function manualTimers() {
    const pending = new Map<number, { callback: () => void; ms: number }>();
    let id = 0;
    const timers: PrTimers = {
      set: (callback, ms) => {
        id += 1;
        pending.set(id, { callback, ms });
        return id;
      },
      clear: handle => {
        pending.delete(handle as number);
      },
    };
    return {
      timers,
      delays: () => [...pending.values()].map(entry => entry.ms),
      async fire() {
        const entries = [...pending.entries()];
        pending.clear();
        for (const [, entry] of entries) entry.callback();
        await settle();
      },
    };
  }

  const monitors: TrackedMonitor[] = [];

  /** Every monitor this file made has finished what it started. */
  async function settle(): Promise<void> {
    for (const monitor of monitors) await monitor.idle();
  }

  function setup(initial = snapshot({ checks: [check('Build', 'pending')] }), store = tempStore()) {
    // On the 15s grid, so the delays below are the cadences themselves.
    let now = 990_000;
    const fake = fakeGithub(initial);
    const clock = manualTimers();
    const out = collector();
    const monitor = new TrackedMonitor({
      store,
      github: fake.github,
      chat: {
        isCode: async () => true,
        project: async () => null,
        archive: async () => undefined,
        isBusy: () => false,
        startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
      },
      emit: out.emit,
      logger: quietLogger,
      timers: clock.timers,
      now: () => now,
      random: () => 0,
      batchWindowMs: 0,
    });
    monitors.push(monitor);
    return {
      store,
      fake,
      clock,
      out,
      monitor,
      advance(ms: number) {
        now += ms;
      },
    };
  }

  describe('PrMonitor polling', () => {
    it('reads a selected agent without retargeting the root watch or looking up unknown sessions', async () => {
      const { store, fake, clock, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await monitor.watch(1, SESSION);
      await settle();
      expect(await monitor.getState('unknown')).toBeNull();
      await store.set('agent', { ...REF, number: 612, source: 'shell', boundAt: '' });
      expect((await monitor.getState('agent'))?.sessionId).toBe('agent');
      await settle();
      expect(clock.delays()).toEqual([POLL_MS.onScreenActive]);
      expect(fake.calls).toEqual(['snapshot', 'snapshot']);
      await monitor.watch(1, null);
      await settle();
      expect(clock.delays()).toEqual([POLL_MS.openedActive]);
      await store.set('dismissed', { ...REF, source: 'shell', boundAt: '', dismissed: true });
      expect(await monitor.getState('dismissed')).toBeNull();
      expect(fake.calls).toHaveLength(2);
    });
    it('refreshes a selected agent on each 30s dialog tick despite GitHub response latency', async () => {
      const { store, fake, monitor, advance } = setup(snapshot({ fetchedAt: 990_000 }));
      await store.set('agent', { ...REF, source: 'shell', boundAt: '' });
      await monitor.getState('agent');
      await settle();
      advance(30_000);
      fake.answer(snapshot({ fetchedAt: 1_020_500 }));
      await monitor.getState('agent');
      await settle();
      advance(30_000);
      await monitor.getState('agent');
      await settle();
      expect(fake.calls).toEqual(['snapshot', 'snapshot', 'snapshot']);
    });

    it('retries gh from selected-agent reads after the recovery interval', async () => {
      const { store, fake, monitor, advance } = setup();
      await store.set('agent', { ...REF, source: 'shell', boundAt: '' });
      fake.answer(new GhError('missing', 'gh is not installed'));
      await monitor.getState('agent');
      await settle();
      fake.answer(snapshot());
      advance(30_000);
      await monitor.getState('agent');
      await settle();
      expect(fake.calls).toEqual(['snapshot']);
      advance(30_001);
      await monitor.getState('agent');
      await settle();
      expect(fake.calls).toEqual(['snapshot', 'snapshot']);
      expect((await monitor.getState('agent'))?.gh).toBe('ok');
    });

    it('does no GitHub work at start, and arms only PRs with automation on', async () => {
      const { store, fake, clock, monitor } = setup();
      await store.set('armed', { ...REF, source: 'shell', boundAt: '', autoArchive: true, lastState: 'OPEN' });
      await store.set('plain', { ...REF, source: 'shell', boundAt: '', lastState: 'OPEN' });
      await store.set('merged', { ...REF, source: 'shell', boundAt: '', autoArchive: true, lastState: 'MERGED' });
      await monitor.start();
      expect(fake.calls).toEqual([]);
      expect(clock.delays()).toEqual([POLL_MS.unopenedArmed]);
    });

    it('polls the conversation on screen every 30s while checks run, slower once they settle', async () => {
      const { store, fake, clock, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await monitor.watch(1, SESSION);
      await settle();
      expect(clock.delays()).toEqual([POLL_MS.onScreenActive]);

      fake.answer(snapshot({ checks: [check('Build', 'pass')] }));
      await clock.fire();
      expect(fake.calls).toEqual(['snapshot', 'snapshot']);
      expect(clock.delays()).toEqual([POLL_MS.onScreenSettled]);
    });

    it('keeps reading a conflicting PR with auto-fix on, though no checks run on it', async () => {
      const { store, clock, monitor } = setup(snapshot({ mergeable: 'CONFLICTING', checks: [] }));
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '', autoFix: true, lastState: 'OPEN' });
      await monitor.watch(1, SESSION);
      await settle();
      expect(clock.delays()).toEqual([POLL_MS.onScreenSettled]);

      await monitor.watch(1, 'another-session');
      await settle();
      expect(clock.delays()).toEqual([POLL_MS.openedSettled]);
    });

    it('slows down when the conversation leaves the screen', async () => {
      const { store, clock, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await monitor.watch(1, SESSION);
      await settle();
      await monitor.watch(1, 'another-session');
      await settle();
      expect(clock.delays()).toEqual([POLL_MS.openedActive]);
    });

    it('stops polling once the PR is merged', async () => {
      const { store, fake, clock, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await monitor.watch(1, SESSION);
      await settle();
      fake.answer(snapshot({ state: 'MERGED' }));
      await clock.fire();
      expect(clock.delays()).toEqual([]);
      expect((await store.get(SESSION))?.lastState).toBe('MERGED');
    });

    it('backs off after failures and resets once a read succeeds', async () => {
      const { store, fake, clock, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      fake.answer(new GhError('failed', 'boom'));
      await monitor.watch(1, SESSION);
      await settle();
      expect(clock.delays()).toEqual([POLL_MS.backoffFloor * 2]);
      await clock.fire();
      expect(clock.delays()).toEqual([POLL_MS.backoffFloor * 4]);
      fake.answer(snapshot({ checks: [check('Build', 'pending')] }));
      await clock.fire();
      expect(clock.delays()).toEqual([POLL_MS.onScreenActive]);
    });

    it('pauses every read for a while after a rate limit', async () => {
      const { store, fake, clock, monitor, advance } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      fake.answer(new GhError('rate-limited', 'API rate limit exceeded'));
      await monitor.watch(1, SESSION);
      await settle();
      expect(Math.min(...clock.delays())).toBeGreaterThanOrEqual(POLL_MS.rateLimitPause);

      // Opening the conversation again during the pause does not read.
      advance(60_000);
      await monitor.watch(1, 'other');
      await monitor.watch(1, SESSION);
      await settle();
      expect(fake.calls).toEqual(['snapshot']);
    });

    it('stops polling everything while gh is missing, until the user refreshes', async () => {
      const { store, fake, clock, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      fake.answer(new GhError('missing', 'gh is not installed'));
      await monitor.watch(1, SESSION);
      await settle();
      expect(clock.delays()).toEqual([]);
      fake.answer(snapshot());
      await monitor.refresh(SESSION);
      expect(clock.delays().length).toBe(1);
    });

    it('reads every conversation due on the same tick in one query', async () => {
      const { store, fake, clock, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await store.set('session-2', { ...REF, number: 612, source: 'shell', boundAt: '' });
      await monitor.watch(1, SESSION);
      await monitor.watch(2, 'session-2');
      await settle();
      expect(clock.delays()).toEqual([POLL_MS.onScreenActive, POLL_MS.onScreenActive]);

      fake.batches.length = 0;
      await clock.fire();
      expect(fake.batches).toEqual([2]);
    });

    it('runs one read at a time per conversation', async () => {
      const { store, fake, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await Promise.all([monitor.refresh(SESSION), monitor.refresh(SESSION), monitor.refresh(SESSION)]);
      expect(fake.calls).toEqual(['snapshot']);
    });

    it('reads soon after the agent pushes to a bound PR', async () => {
      const { store, clock, monitor } = setup(snapshot({ checks: [check('Build', 'pass')] }));
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await monitor.watch(1, SESSION);
      await settle();
      monitor.observeToolEnd(SESSION, {
        id: 'c',
        name: 'bash_execute',
        input: { command: 'git push' },
        status: 'done',
        preview: 'Everything up-to-date',
      });
      await settle();
      expect(clock.delays()).toEqual([15_000]);
    });

    it.each([
      ['open', snapshot()],
      ['draft', snapshot({ isDraft: true })],
      ['merged', snapshot({ state: 'MERGED' })],
      ['closed', snapshot({ state: 'CLOSED' })],
    ])('clears the spinner once a read of a %s PR lands', async (_name, answer) => {
      const { store, out, monitor } = setup(answer);
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      await monitor.refresh(SESSION);
      await settle();
      expect(out.last()?.refreshing).toBe(false);
    });

    it('clears the spinner when a read fails', async () => {
      const { store, fake, out, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      fake.answer(new GhError('failed', 'boom'));
      await monitor.refresh(SESSION);
      await settle();
      expect(out.last()).toMatchObject({ refreshing: false, error: 'boom' });
    });

    it('clears the spinner when a read is skipped during a rate-limit pause', async () => {
      const { store, fake, out, monitor } = setup();
      await store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
      fake.answer(new GhError('rate-limited', 'API rate limit exceeded'));
      await monitor.refresh(SESSION);
      await monitor.refresh(SESSION);
      await settle();
      expect(fake.calls).toEqual(['snapshot']);
      expect(out.last()?.refreshing).toBe(false);
    });

    describe('a finished PR', () => {
      const merged = snapshot({ state: 'MERGED', mergedAt: '2026-10-01T00:00:00Z', checks: [check('Build', 'pass')] });

      async function finishOnScreen(answer = merged) {
        const env = setup();
        await env.store.set(SESSION, { ...REF, source: 'shell', boundAt: '' });
        await env.monitor.watch(1, SESSION);
        await settle();
        env.fake.answer(answer);
        await env.clock.fire();
        env.fake.calls.length = 0;
        return env;
      }

      it.each([
        ['merged', merged],
        ['closed', snapshot({ state: 'CLOSED' })],
      ])('arms no timer once %s', async (_name, answer) => {
        const { clock, out } = await finishOnScreen(answer);
        expect(clock.delays()).toEqual([]);
        expect(out.last()).toMatchObject({ refreshing: false, snapshot: { state: answer.state } });
      });

      it('is not read again when it leaves the screen and comes back', async () => {
        const { fake, clock, monitor, advance } = await finishOnScreen();
        await monitor.watch(1, 'another-session');
        advance(POLL_MS.openedSettled);
        const state = await monitor.watch(1, SESSION);
        await settle();
        expect(fake.calls).toEqual([]);
        expect(clock.delays()).toEqual([]);
        expect(state).toMatchObject({ refreshing: false, snapshot: { state: 'MERGED' } });
      });

      it('keeps its last read across a relaunch, so opening it reads nothing', async () => {
        const { store } = await finishOnScreen();
        expect((await store.get(SESSION))?.finalSnapshot).toMatchObject({ state: 'MERGED', checks: [] });

        const relaunched = setup(merged, store);
        await relaunched.monitor.start();
        const state = await relaunched.monitor.watch(1, SESSION);
        await settle();
        expect(relaunched.fake.calls).toEqual([]);
        expect(relaunched.clock.delays()).toEqual([]);
        expect(state?.snapshot).toMatchObject({ state: 'MERGED', additions: 157, mergedAt: '2026-10-01T00:00:00Z' });
        expect(state?.binding?.finalSnapshot).toBeUndefined();
      });

      it('reads a merged PR stored before its last read was kept, once', async () => {
        const { store, fake, monitor } = setup(merged);
        await store.set(SESSION, { ...REF, source: 'shell', boundAt: '', lastState: 'MERGED' });
        await monitor.watch(1, SESSION);
        await settle();
        await monitor.watch(1, 'another-session');
        await monitor.watch(1, SESSION);
        await settle();
        expect(fake.calls).toEqual(['snapshot']);
      });

      it('is not re-armed by a push or a finished turn', async () => {
        const { fake, clock, monitor } = await finishOnScreen();
        monitor.observeToolEnd(SESSION, {
          id: 'c',
          name: 'bash_execute',
          input: { command: 'git push' },
          status: 'done',
          preview: 'Everything up-to-date',
        });
        monitor.turnSettled(SESSION);
        await settle();
        expect(clock.delays()).toEqual([]);
        expect(fake.calls).toEqual([]);
      });

      it('refuses to switch an automation on, without reading', async () => {
        const { fake, clock, monitor } = await finishOnScreen();
        for (const option of ['autoFix', 'autoMerge', 'autoArchive'] as const) {
          expect(await monitor.setOption(SESSION, option, true)).toMatchObject({ ok: false });
        }
        await settle();
        expect(fake.calls).toEqual([]);
        expect(clock.delays()).toEqual([]);
      });

      it('arms nothing after the bar is dismissed', async () => {
        const { fake, clock, monitor } = await finishOnScreen();
        await monitor.dismiss(SESSION);
        await monitor.watch(1, 'another-session');
        await monitor.watch(1, SESSION);
        await settle();
        expect(fake.calls).toEqual([]);
        expect(clock.delays()).toEqual([]);
      });

      it('reads a closed PR once on a manual refresh, still unarmed', async () => {
        const { fake, clock, monitor, out } = await finishOnScreen(snapshot({ state: 'CLOSED' }));
        await monitor.refresh(SESSION);
        await settle();
        expect(fake.calls).toEqual(['snapshot']);
        expect(clock.delays()).toEqual([]);
        expect(out.last()?.refreshing).toBe(false);
      });

      it('polls again, and forgets its kept read, once a closed PR is reopened', async () => {
        const { store, fake, clock, monitor } = await finishOnScreen(snapshot({ state: 'CLOSED' }));
        fake.answer(snapshot({ checks: [check('Build', 'pending')] }));
        await monitor.refresh(SESSION);
        expect(clock.delays()).toEqual([POLL_MS.onScreenActive]);
        expect(await store.get(SESSION)).toMatchObject({ lastState: 'OPEN' });
        expect((await store.get(SESSION))?.finalSnapshot).toBeUndefined();
      });
    });
  });
});

describe('summaries', () => {
  const SESSION = 'session-1';

  function setup(branch: string | null = null) {
    const store = tempStore();
    const fake = fakeGithub();
    const github = Object.assign(fake.github, { findOpenForBranch: async () => REF.url });
    const out = collector();
    const pushed: PrSummaryEvent[] = [];
    const deps: PrMonitorDeps = {
      store,
      github,
      chat: {
        isCode: async () => true,
        project: async () => (branch ? { workingDirectory: '/repo', branch } : null),
        archive: async () => undefined,
        isBusy: () => false,
        startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
      },
      emit: out.emit,
      emitSummary: event => pushed.push(event),
      logger: quietLogger,
      batchWindowMs: 0,
    };
    const monitor = new TrackedMonitor(deps);
    return { store, fake, out, monitor, pushed, deps };
  }

  const bound = { ...REF, source: 'shell' as const, boundAt: '' };

  function shellCall(command: string, preview: string): ChatToolCall {
    return { id: 'c1', name: 'bash_execute', input: { command }, status: 'done', preview };
  }

  describe('PrMonitor sidebar summaries', () => {
    it('builds every summary from the binding file without reading GitHub', async () => {
      const { store, fake, monitor } = setup();
      await store.set('open', { ...bound, lastState: 'OPEN' });
      await store.set('draft', { ...bound, number: 7, lastState: 'OPEN', lastDraft: true });
      await store.set('merged', {
        ...bound,
        lastState: 'MERGED',
        finalSnapshot: { ...snapshot({ state: 'MERGED' }), checks: [] },
      });
      await store.set('dismissed', { ...bound, lastState: 'CLOSED', dismissed: true });
      await store.set('never-read', bound);

      expect(await monitor.summaries()).toEqual([
        { sessionId: 'open', summary: { number: 611, state: 'open', stale: true, repo: 'example-org/widgets' } },
        { sessionId: 'draft', summary: { number: 7, state: 'draft', stale: true, repo: 'example-org/widgets' } },
        { sessionId: 'merged', summary: { number: 611, state: 'merged', repo: 'example-org/widgets' } },
      ]);
      await monitor.idle();
      expect(fake.calls).toEqual([]);
      expect(fake.batches).toEqual([]);
      monitor.dispose();
    });

    it('pushes only when a session icon actually changes', async () => {
      const { fake, monitor, pushed } = setup();
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      expect(pushed).toEqual([
        {
          sessionId: SESSION,
          summary: { number: 611, state: 'open', attention: 'awaitingReview', repo: 'example-org/widgets' },
        },
      ]);

      await monitor.refresh(SESSION);
      expect(pushed).toHaveLength(1);

      fake.answer(snapshot({ isDraft: true }));
      await monitor.refresh(SESSION);
      fake.answer(snapshot({ state: 'MERGED' }));
      await monitor.refresh(SESSION);
      expect(pushed.slice(1).map(event => event.summary?.state)).toEqual(['draft', 'merged']);
      monitor.dispose();
    });

    it('matches what the bar shows for the same read', async () => {
      const { fake, out, monitor, pushed } = setup();
      fake.answer(snapshot({ state: 'CLOSED' }));
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      expect(out.last()?.snapshot?.state).toBe('CLOSED');
      expect(pushed[pushed.length - 1]?.summary?.state).toBe('closed');
      monitor.dispose();
    });

    it('drops the icon when the bar is dismissed, also after a relaunch', async () => {
      const { monitor, pushed, deps } = setup();
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      await monitor.dismiss(SESSION);
      expect(pushed[pushed.length - 1]).toEqual({ sessionId: SESSION, summary: null });
      expect(await monitor.summaries()).toEqual([]);
      monitor.dispose();

      const relaunched = new TrackedMonitor(deps);
      expect(await relaunched.summaries()).toEqual([]);
      relaunched.dispose();
    });

    it('keeps a dismissed icon gone when the same PR is detected again', async () => {
      const { monitor, pushed } = setup('feature');
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      await monitor.dismiss(SESSION);
      const before = pushed.length;

      monitor.observeToolEnd(SESSION, shellCall('git push', `remote:   ${REF.url}`));
      monitor.observeToolEnd(SESSION, shellCall('gh pr create', REF.url));
      await monitor.watch(1, SESSION);
      await monitor.idle();
      expect(pushed).toHaveLength(before);
      expect(await monitor.summaries()).toEqual([]);
      monitor.dispose();
    });

    it('brings the icon back on a manual bind of the same PR, or when another PR is detected', async () => {
      const { monitor, pushed } = setup();
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      await monitor.dismiss(SESSION);

      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      expect(pushed[pushed.length - 1]).toEqual({
        sessionId: SESSION,
        summary: { number: 611, state: 'open', attention: 'awaitingReview', repo: 'example-org/widgets' },
      });

      await monitor.dismiss(SESSION);
      monitor.observeToolEnd(SESSION, shellCall('gh pr create', 'https://github.com/example-org/widgets/pull/700'));
      await monitor.idle();
      expect(pushed[pushed.length - 1]).toEqual({
        sessionId: SESSION,
        summary: { number: 700, state: 'open', attention: 'awaitingReview', repo: 'example-org/widgets' },
      });
      monitor.dispose();
    });

    it('drops the icon when the session is deleted', async () => {
      const { monitor, pushed } = setup();
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      await monitor.forget(SESSION);
      expect(pushed[pushed.length - 1]).toEqual({ sessionId: SESSION, summary: null });
      expect(await monitor.summaries()).toEqual([]);
      monitor.dispose();
    });

    it('remembers a draft across a relaunch', async () => {
      const { store, fake, monitor } = setup();
      fake.answer(snapshot({ isDraft: true }));
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      expect(await store.get(SESSION)).toMatchObject({ lastState: 'OPEN', lastDraft: true });
      monitor.dispose();
    });

    it('shows a PR in the merge queue as queued, open again once it leaves, and merged when it lands', async () => {
      const { fake, out, monitor, pushed } = setup();
      const inQueue = { enabled: true, entry: { state: 'QUEUED', position: 1 } };
      fake.answer(snapshot({ mergeQueue: inQueue }));
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      expect(out.last()?.autoMerge.queued).toEqual({ position: 1 });
      expect(pushed[pushed.length - 1]?.summary?.state).toBe('queued');

      fake.answer(snapshot({ mergeQueue: { enabled: true } }));
      await monitor.refresh(SESSION);
      expect(pushed[pushed.length - 1]?.summary?.state).toBe('open');

      fake.answer(snapshot({ mergeQueue: inQueue }));
      await monitor.refresh(SESSION);
      fake.answer(snapshot({ state: 'MERGED', mergeQueue: inQueue }));
      await monitor.refresh(SESSION);
      expect(pushed.slice(-2).map(event => event.summary?.state)).toEqual(['queued', 'merged']);
      monitor.dispose();
    });

    it('never shows queued from the binding file: only a read this launch says a PR is in the queue', async () => {
      const first = setup();
      first.fake.answer(snapshot({ mergeQueue: { enabled: true, entry: { state: 'QUEUED', position: 1 } } }));
      await first.monitor.bindManual(SESSION, REF.url);
      await first.monitor.idle();
      expect((await first.monitor.summaries())[0]?.summary?.state).toBe('queued');
      first.monitor.dispose();

      const relaunched = new TrackedMonitor(first.deps);
      expect(await relaunched.summaries()).toEqual([
        {
          sessionId: SESSION,
          // Last seen in the queue, so the stored auto-merge badge stands in for the queued state.
          summary: {
            number: 611,
            state: 'open',
            attention: 'awaitingReview',
            autoMerge: true,
            stale: true,
            repo: 'example-org/widgets',
          },
        },
      ]);
      relaunched.dispose();
    });

    it('pushes when what the PR waits on changes, even with its state unchanged', async () => {
      const { fake, monitor, pushed } = setup();
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();

      fake.answer(snapshot({ checks: [check('build', 'fail')] }));
      await monitor.refresh(SESSION);
      fake.answer(snapshot({ reviewDecision: 'APPROVED', mergeStateStatus: 'BEHIND' }));
      await monitor.refresh(SESSION);
      fake.answer(snapshot({ reviewDecision: 'APPROVED', mergeStateStatus: 'BEHIND' }));
      await monitor.refresh(SESSION);

      expect(pushed.map(event => event.summary?.attention)).toEqual(['awaitingReview', 'ciFailed', 'ready']);
      expect(pushed[pushed.length - 1]?.summary).toMatchObject({ state: 'open', behind: true });
      monitor.dispose();
    });

    it('serves the last attention and badges after a relaunch, marked stale, without reading GitHub', async () => {
      const first = setup();
      first.fake.answer(snapshot({ mergeable: 'CONFLICTING', mergeStateStatus: 'BEHIND', autoMergeArmed: true }));
      await first.monitor.bindManual(SESSION, REF.url);
      await first.monitor.idle();
      expect(await first.store.get(SESSION)).toMatchObject({
        lastAttention: 'conflict',
        lastBehind: true,
        lastAutoMerge: true,
      });
      first.monitor.dispose();

      const relaunched = new TrackedMonitor(first.deps);
      const callsBefore = first.fake.calls.length;
      expect(await relaunched.summaries()).toEqual([
        {
          sessionId: SESSION,
          summary: {
            number: 611,
            state: 'open',
            attention: 'conflict',
            behind: true,
            autoMerge: true,
            stale: true,
            repo: 'example-org/widgets',
          },
        },
      ]);
      expect(first.fake.calls.length).toBe(callsBefore);
      relaunched.dispose();
    });

    it('clears the stored badges once a read no longer finds them', async () => {
      const { fake, store, monitor } = setup();
      fake.answer(snapshot({ mergeStateStatus: 'BEHIND', autoMergeArmed: true }));
      await monitor.bindManual(SESSION, REF.url);
      await monitor.idle();
      fake.answer(snapshot());
      await monitor.refresh(SESSION);
      const stored = await store.get(SESSION);
      expect(stored).toMatchObject({ lastAttention: 'awaitingReview' });
      expect(stored).not.toHaveProperty('lastBehind');
      expect(stored).not.toHaveProperty('lastAutoMerge');
      monitor.dispose();
    });
  });
});

describe('auto-fix', () => {
  const SESSION = 'session-1';
  const bound: PrBinding = {
    ...REF,
    source: 'shell',
    boundAt: '',
    lastState: 'OPEN',
    autoFix: true,
    autoFixMax: DEFAULT_AUTO_FIX_ATTEMPTS,
  };
  const failing = snapshot({ headSha: 'sha-bad', checks: [check('Build', 'fail')] });

  function setup({
    busy = false,
    accept = true,
    attempts,
  }: { busy?: boolean; accept?: boolean; attempts?: number } = {}) {
    const store = tempStore();
    const fake = fakeGithub(failing);
    const out = collector();
    const started: { prompt: string; origin: ChatAutomaticOrigin }[] = [];
    const state = { busy, accept, refuseAsBusy: true, attempts, attemptReads: 0 };
    const monitor = new TrackedMonitor({
      store,
      github: fake.github,
      chat: {
        isCode: async () => true,
        project: async () => null,
        archive: async () => undefined,
        isBusy: () => state.busy,
        startAutoFix: async (_sessionId, prompt, origin) => {
          if (!state.accept) return { ok: false, busy: state.refuseAsBusy, error: 'Sign in to send a message.' };
          started.push({ prompt, origin });
          return { ok: true };
        },
      },
      emit: out.emit,
      logger: quietLogger,
      batchWindowMs: 0,
      ...(attempts === undefined
        ? {}
        : {
            autoFixAttempts: async () => {
              state.attemptReads++;
              return state.attempts ?? DEFAULT_AUTO_FIX_ATTEMPTS;
            },
          }),
    });
    return { store, fake, out, monitor, started, state };
  }

  describe('PrMonitor auto-fix', () => {
    it('starts one turn for a failing run, recording the attempt first', async () => {
      const { store, monitor, started, out, fake } = setup();
      await store.set(SESSION, bound);
      await monitor.refresh(SESSION);

      expect(fake.calls).toEqual(['snapshot+threads']);
      expect(started).toHaveLength(1);
      expect(started[0].origin).toEqual({
        kind: 'auto-fix',
        prUrl: REF.url,
        prNumber: 611,
        summary: '1 failing check on #611',
      });
      const stored = await store.get(SESSION);
      expect(stored?.autoFixAttempts).toBe(1);
      expect(stored?.autoFixHandled).toEqual(['ci:sha-bad']);
      expect(out.last().autoFix.status).toBe('started');

      await monitor.refresh(SESSION);
      expect(started).toHaveLength(1);
    });

    it('waits while a turn runs, then starts once it ends', async () => {
      const { store, monitor, started, state, out } = setup({ busy: true });
      await store.set(SESSION, bound);
      await monitor.refresh(SESSION);
      expect(started).toHaveLength(0);
      expect(out.last().autoFix.status).toBe('waiting');

      state.busy = false;
      monitor.turnSettled(SESSION);
      await monitor.idle();
      expect(started).toHaveLength(1);
      expect(out.last().autoFix.status).toBe('started');
    });

    it('spends nothing when the start is refused', async () => {
      const { store, monitor, started, out } = setup({ accept: false });
      await store.set(SESSION, bound);
      await monitor.refresh(SESSION);
      expect(started).toHaveLength(0);
      const stored = await store.get(SESSION);
      expect(stored?.autoFixAttempts ?? 0).toBe(0);
      expect(stored?.autoFixHandled ?? []).toEqual([]);
      expect(out.last().autoFix.status).toBe('waiting');
    });

    it('gives the attempt back and says why when the turn is refused', async () => {
      const { store, monitor, started, out, state } = setup({ accept: false });
      state.refuseAsBusy = false;
      await store.set(SESSION, bound);
      await monitor.refresh(SESSION);
      expect(started).toHaveLength(0);
      expect((await store.get(SESSION))?.autoFixAttempts ?? 0).toBe(0);
      expect(out.last().autoFix.note).toContain('Sign in to send a message.');
    });

    it('starts once when a read and a turn ending ask at the same time', async () => {
      const { store, monitor, started, state } = setup({ busy: true });
      await store.set(SESSION, bound);
      await monitor.refresh(SESSION);
      state.busy = false;
      await Promise.all([monitor.refresh(SESSION), Promise.resolve(monitor.turnSettled(SESSION))]);
      await monitor.idle();
      expect(started).toHaveLength(1);
      expect((await store.get(SESSION))?.autoFixAttempts).toBe(1);
    });

    it('keeps saying it gave up while checks run again', async () => {
      const { store, monitor, out, fake } = setup();
      await store.set(SESSION, { ...bound, autoFixAttempts: DEFAULT_AUTO_FIX_ATTEMPTS });
      await monitor.refresh(SESSION);
      fake.answer(snapshot({ headSha: 'sha-next', checks: [check('Build', 'pending')] }));
      await monitor.refresh(SESSION);
      expect(out.last().autoFix.status).toBe('exhausted');
    });

    it('says so in the bar when it gives up', async () => {
      const { store, monitor, started, out } = setup();
      await store.set(SESSION, { ...bound, autoFixAttempts: DEFAULT_AUTO_FIX_ATTEMPTS });
      await monitor.refresh(SESSION);
      expect(started).toHaveLength(0);
      expect(out.last().autoFix).toMatchObject({ status: 'exhausted', attempts: DEFAULT_AUTO_FIX_ATTEMPTS });
      expect(out.last().autoFix.note).toContain('gave up');
    });

    it('leaves a PR that gave up at the old limit stopped until the box is re-checked', async () => {
      const { store, monitor, started, out } = setup();
      const { autoFixMax: _, ...legacy } = bound;
      await store.set(SESSION, { ...legacy, autoFixAttempts: 3 });
      await monitor.refresh(SESSION);
      expect(started).toHaveLength(0);
      expect(out.last().autoFix).toMatchObject({ status: 'exhausted', attempts: 3, max: 3 });
      expect(out.last().autoFix.note).toContain('gave up after 3 attempts');

      await monitor.setOption(SESSION, 'autoFix', true);
      await monitor.idle();
      expect(started).toHaveLength(1);
      expect(started[0].prompt).toContain(`Attempt 1 of ${DEFAULT_AUTO_FIX_ATTEMPTS}`);
      expect(await store.get(SESSION)).toMatchObject({ autoFixAttempts: 1, autoFixMax: DEFAULT_AUTO_FIX_ATTEMPTS });
      expect(out.last().autoFix.max).toBe(DEFAULT_AUTO_FIX_ATTEMPTS);
    });

    it('keeps a binding part-way through the old budget at three attempts', async () => {
      const { store, monitor, started, out } = setup();
      const { autoFixMax: _, ...legacy } = bound;
      await store.set(SESSION, { ...legacy, autoFixAttempts: 2 });
      await monitor.refresh(SESSION);
      expect(started).toHaveLength(1);
      expect(out.last().autoFix).toMatchObject({ status: 'started', attempts: 3, max: 3 });
      expect(out.last().autoFix.note).toContain('attempt 3 of 3');
    });

    it('keeps a legacy binding that ran out at three stopped while checks run again', async () => {
      const { store, monitor, out, fake } = setup();
      const { autoFixMax: _, ...legacy } = bound;
      await store.set(SESSION, { ...legacy, autoFixAttempts: 3 });
      await monitor.refresh(SESSION);
      fake.answer(snapshot({ headSha: 'sha-next', checks: [check('Build', 'pending')] }));
      await monitor.refresh(SESSION);
      expect(out.last().autoFix.status).toBe('exhausted');
    });

    it('grants five attempts when the box is ticked', async () => {
      const { store, monitor, out } = setup();
      await store.set(SESSION, { ...bound, autoFix: false, autoFixAttempts: 0 });
      await monitor.setOption(SESSION, 'autoFix', true);
      await monitor.idle();
      expect((await store.get(SESSION))?.autoFixMax).toBe(5);
      expect(out.last().autoFix.max).toBe(5);
    });

    it('grants the Settings value when the box is ticked, and reports it while auto-fix is off', async () => {
      const { store, monitor, out, started } = setup({ attempts: 2 });
      await store.set(SESSION, { ...bound, autoFix: false, autoFixAttempts: 0 });
      await monitor.start();
      await monitor.refresh(SESSION);
      expect(out.last().autoFix).toMatchObject({ status: 'off', max: 2 });

      await monitor.setOption(SESSION, 'autoFix', true);
      await monitor.idle();
      expect(started[0].prompt).toContain('Attempt 1 of 2');
      expect(await store.get(SESSION)).toMatchObject({ autoFixAttempts: 1, autoFixMax: 2 });
      expect(out.last().autoFix).toMatchObject({ attempts: 1, max: 2 });
    });

    it('reads the setting once per tick of the box, not per read', async () => {
      const { store, monitor, state } = setup({ attempts: 2 });
      await store.set(SESSION, { ...bound, autoFix: false });
      await monitor.setOption(SESSION, 'autoFix', true);
      await monitor.idle();
      const reads = state.attemptReads;
      await monitor.refresh(SESSION);
      await monitor.refresh(SESSION);
      expect(state.attemptReads).toBe(reads);
    });

    it('says how many a re-check would allow when it gives up', async () => {
      const { store, monitor, out } = setup({ attempts: 2 });
      await monitor.start();
      await store.set(SESSION, { ...bound, autoFixMax: 2, autoFixAttempts: 2 });
      await monitor.refresh(SESSION);
      expect(out.last().autoFix.note).toBe('Auto-fix gave up after 2 attempts. Re-check the box to allow 2 more.');
    });

    it('raises PRs already on when the setting goes up, and resumes one that gave up', async () => {
      const { store, monitor, out, started } = setup({ attempts: 2 });
      await store.set(SESSION, { ...bound, autoFixMax: 2, autoFixAttempts: 2 });
      await store.set('off', { ...bound, autoFix: false, autoFixMax: 2 });
      await store.set('merged', { ...bound, lastState: 'MERGED', autoFixMax: 2 });
      await monitor.refresh(SESSION);
      expect(out.last().autoFix.status).toBe('exhausted');

      await monitor.setAutoFixAttempts(4);
      await monitor.idle();
      expect((await store.get(SESSION))?.autoFixMax).toBe(4);
      expect((await store.get('off'))?.autoFixMax).toBe(2);
      expect((await store.get('merged'))?.autoFixMax).toBe(2);
      expect(started).toHaveLength(1);
      expect(started[0].prompt).toContain('Attempt 3 of 4');
    });

    it('updates what a re-check would allow when the setting changes after it gave up', async () => {
      const { store, monitor, out } = setup({ attempts: 5 });
      await monitor.start();
      await store.set(SESSION, { ...bound, autoFixMax: 5, autoFixAttempts: 5 });
      await monitor.refresh(SESSION);
      expect(out.last().autoFix.note).toContain('allow 5 more');

      await monitor.setAutoFixAttempts(2);
      expect(out.last()).toMatchObject({ sessionId: SESSION, autoFix: { status: 'exhausted', max: 5 } });
      expect(out.last().autoFix.note).toBe('Auto-fix gave up after 5 attempts. Re-check the box to allow 2 more.');
    });

    it('raises a legacy binding too', async () => {
      const { store, monitor } = setup({ attempts: 5 });
      const { autoFixMax: _, ...legacy } = bound;
      await store.set(SESSION, { ...legacy, autoFixAttempts: 1 });
      await monitor.setAutoFixAttempts(4);
      expect((await store.get(SESSION))?.autoFixMax).toBe(4);
    });

    it('leaves PRs already on at their budget when the setting goes down', async () => {
      const { store, monitor, out } = setup({ attempts: 5 });
      await store.set(SESSION, { ...bound, autoFixMax: 5, autoFixAttempts: 3 });
      await monitor.setAutoFixAttempts(2);
      expect(await store.get(SESSION)).toMatchObject({ autoFixMax: 5, autoFixAttempts: 3 });
      await monitor.refresh(SESSION);
      expect(out.last().autoFix).toMatchObject({ attempts: 4, max: 5 });
    });

    it('stops when the box is unchecked, and re-checking refills the attempts', async () => {
      const { store, monitor, started, fake } = setup();
      await store.set(SESSION, { ...bound, autoFix: false, autoFixAttempts: DEFAULT_AUTO_FIX_ATTEMPTS });
      await monitor.refresh(SESSION);
      expect(fake.calls).toEqual(['snapshot']);
      expect(started).toHaveLength(0);

      await monitor.setOption(SESSION, 'autoFix', true);
      await monitor.idle();
      expect(started).toHaveLength(1);
      expect((await store.get(SESSION))?.autoFixAttempts).toBe(1);

      await monitor.setOption(SESSION, 'autoFix', false);
      fake.answer(snapshot({ headSha: 'sha-other', checks: [check('Build', 'fail')] }));
      await monitor.refresh(SESSION);
      expect(started).toHaveLength(1);
    });
    it('starts one turn for a merge conflict and says so on the bar until the turn ends', async () => {
      const { store, monitor, started, out, fake } = setup();
      fake.answer(snapshot({ headSha: 'sha-head', baseSha: 'sha-base', mergeable: 'CONFLICTING' }));
      await store.set(SESSION, bound);
      await monitor.refresh(SESSION);

      expect(started).toHaveLength(1);
      expect(started[0].origin.summary).toBe('merge conflicts on #611');
      expect(started[0].prompt).toContain('git fetch origin main');
      expect((await store.get(SESSION))?.autoFixHandled).toEqual(['conflict:sha-head:sha-base']);
      expect(out.last().autoFix).toMatchObject({ status: 'started', conflicts: true });

      await monitor.refresh(SESSION);
      expect(started).toHaveLength(1);

      monitor.turnSettled(SESSION);
      await monitor.idle();
      expect(out.last().autoFix.conflicts).toBeUndefined();
    });
  });
});

describe('auto-merge', () => {
  const SESSION = 'session-1';
  const bound: PrBinding = { ...REF, source: 'shell', boundAt: '', lastState: 'OPEN' };

  const ready = (overrides: Partial<PrSnapshot> = {}) =>
    snapshot({
      reviewDecision: 'APPROVED',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      checks: [check('Build', 'pass'), check('Docs', 'skipped', false)],
      headSha: 'sha-ready',
      ...overrides,
    });

  function setup(initial: PrSnapshot) {
    const store = tempStore();
    const fake = fakeGithub(initial);
    const out = collector();
    const pushed: PrSummaryEvent[] = [];
    const monitor = new PrMonitor({
      store,
      github: fake.github,
      chat: {
        isCode: async () => true,
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
    return { store, fake, out, monitor, pushed };
  }

  describe('desktopMergeReadiness', () => {
    it('is ready only when approved, mergeable, clean and every check passed or skipped', () => {
      expect(desktopMergeReadiness(ready())).toEqual({ ready: true, via: 'merge', method: 'squash' });
    });

    it('enqueues instead on a base branch with a merge queue, whatever methods the repo allows', () => {
      const queue = { mergeQueue: { enabled: true } };
      expect(desktopMergeReadiness(ready(queue))).toEqual({ ready: true, via: 'queue' });
      expect(
        desktopMergeReadiness(ready({ ...queue, repoSettings: { autoMergeAllowed: false, allowedMethods: [] } }))
      ).toEqual({ ready: true, via: 'queue' });
    });

    it.each([
      ['a draft', { isDraft: true }],
      ['conflicts', { mergeable: 'CONFLICTING' as const }],
      ['unknown mergeability', { mergeable: 'UNKNOWN' as const }],
      ['no approval', { reviewDecision: 'REVIEW_REQUIRED' as const }],
      ['changes requested', { reviewDecision: 'CHANGES_REQUESTED' as const }],
      ['a required check running', { checks: [check('Build', 'pending')] }],
      ['a required check failing', { checks: [check('Build', 'fail')] }],
      ['an optional check failing', { checks: [check('Build', 'pass'), check('Lint', 'fail', false)] }],
      ['blocked by branch protection', { mergeStateStatus: 'BLOCKED' }],
      ['behind the base', { mergeStateStatus: 'BEHIND' }],
      ['unstable', { mergeStateStatus: 'UNSTABLE' }],
      ['closed', { state: 'CLOSED' as const }],
      ['no merge method', { repoSettings: { autoMergeAllowed: false, allowedMethods: [] } }],
    ])('is not ready with %s', (_label, overrides) => {
      expect(desktopMergeReadiness(ready(overrides)).ready).toBe(false);
    });
  });

  describe('PrMonitor auto-merge on a repo with GitHub auto-merge', () => {
    const native = (overrides: Partial<PrSnapshot> = {}) =>
      snapshot({
        repoSettings: { autoMergeAllowed: true, allowedMethods: ['squash', 'merge'], defaultMethod: 'merge' },
        ...overrides,
      });

    it('arms it on GitHub with the repo method, and cancels it on uncheck', async () => {
      const { store, fake, out, monitor } = setup(native());
      await store.set(SESSION, bound);
      fake.github.enableAutoMerge = async (_ref, method) => {
        fake.calls.push(`enable-auto:${method}`);
        fake.answer(native({ autoMergeArmed: true }));
      };
      expect(await monitor.setOption(SESSION, 'autoMerge', true)).toEqual({ ok: true });
      expect(fake.calls).toContain('enable-auto:merge');
      expect(await store.get(SESSION)).toMatchObject({ autoMerge: true, autoMergeMode: 'github' });
      expect(out.last()?.autoMerge.mode).toBe('github');

      expect(await monitor.setOption(SESSION, 'autoMerge', false)).toEqual({ ok: true });
      expect(fake.calls).toContain('disable-auto');
      expect((await store.get(SESSION))?.autoMerge).toBe(false);
      expect(fake.calls.some(call => call.startsWith('merge:'))).toBe(false);
    });

    it('keeps the box checked when cancelling fails and GitHub still has it armed', async () => {
      const { store, fake, monitor } = setup(native({ autoMergeArmed: true }));
      await store.set(SESSION, { ...bound, autoMerge: true, autoMergeMode: 'github' });
      fake.github.disableAutoMerge = async () => {
        throw new GhError('failed', 'network down');
      };
      expect(await monitor.setOption(SESSION, 'autoMerge', false)).toMatchObject({ ok: false });
      expect((await store.get(SESSION))?.autoMerge).toBe(true);
    });

    it('does not tick the box when GitHub refuses to arm it', async () => {
      const { store, fake, monitor } = setup(native());
      await store.set(SESSION, bound);
      fake.github.enableAutoMerge = async () => {
        throw new GhError('failed', 'Pull request is in clean status');
      };
      expect(await monitor.setOption(SESSION, 'autoMerge', true)).toMatchObject({ ok: false });
      expect((await store.get(SESSION))?.autoMerge).toBeUndefined();
    });

    it('clears the flag when GitHub turns auto-merge off on its own', async () => {
      const { store, fake, out, monitor } = setup(native({ autoMergeArmed: false }));
      await store.set(SESSION, { ...bound, autoMerge: true, autoMergeMode: 'github' });
      await monitor.refresh(SESSION);
      expect((await store.get(SESSION))?.autoMerge).toBe(false);
      expect(out.last()?.autoMerge.note).toMatch(/turned auto-merge off/);
      expect(fake.calls.some(call => call.startsWith('merge:'))).toBe(false);
    });
  });

  describe('PrMonitor auto-merge on a repo without it (desktop merges)', () => {
    it('waits while the PR is not ready, saying why', async () => {
      const { store, fake, out, monitor } = setup(snapshot({ reviewDecision: 'REVIEW_REQUIRED' }));
      await store.set(SESSION, bound);
      expect(await monitor.setOption(SESSION, 'autoMerge', true)).toEqual({ ok: true });
      expect(await store.get(SESSION)).toMatchObject({ autoMerge: true, autoMergeMode: 'desktop' });
      expect(fake.calls.some(call => call.startsWith('merge:'))).toBe(false);
      expect(out.last()?.autoMerge).toMatchObject({ mode: 'desktop', note: expect.stringMatching(/approving review/) });
    });

    it('merges once ready, pinned to the head commit it checked', async () => {
      const { store, fake, monitor } = setup(snapshot({ reviewDecision: 'REVIEW_REQUIRED' }));
      await store.set(SESSION, bound);
      await monitor.setOption(SESSION, 'autoMerge', true);
      fake.answer(ready());
      await monitor.refresh(SESSION);
      expect(fake.calls.filter(call => call.startsWith('merge:'))).toEqual(['merge:squash:sha-ready']);
    });

    it('disarms instead of retrying when GitHub refuses the merge', async () => {
      const { store, fake, out, monitor } = setup(ready());
      await store.set(SESSION, { ...bound, autoMerge: true, autoMergeMode: 'desktop' });
      fake.github.merge = async () => {
        throw new GhError('failed', 'Head branch was modified');
      };
      await monitor.refresh(SESSION);
      expect((await store.get(SESSION))?.autoMerge).toBe(false);
      expect(out.last()?.autoMerge).toMatchObject({
        mode: null,
        error: 'Auto-merge stopped: GitHub refused the merge: Head branch was modified',
      });
      expect(out.last()?.autoMerge.note).toBeUndefined();
    });

    it('cancels by unchecking before it is ready, and then never merges', async () => {
      const { store, fake, monitor } = setup(snapshot({ reviewDecision: 'REVIEW_REQUIRED' }));
      await store.set(SESSION, bound);
      await monitor.setOption(SESSION, 'autoMerge', true);
      expect(await monitor.setOption(SESSION, 'autoMerge', false)).toEqual({ ok: true });
      fake.answer(ready());
      await monitor.refresh(SESSION);
      expect(fake.calls.some(call => call.startsWith('merge:'))).toBe(false);
      expect(fake.calls).not.toContain('disable-auto');
    });

    it('starts a newly bound PR with auto-merge off, whatever the last one had', async () => {
      const { store, monitor } = setup(snapshot());
      await store.set(SESSION, { ...bound, autoMerge: false, autoArchive: false });
      await monitor.bindManual(SESSION, 'https://github.com/example-org/widgets/pull/700');
      const next = await store.get(SESSION);
      expect(next?.number).toBe(700);
      expect(next?.autoMerge).toBeUndefined();
      monitor.dispose();
    });
  });

  describe('PrMonitor auto-merge on a merge-queue base (desktop enqueues)', () => {
    const queued = (overrides: Partial<PrSnapshot> = {}) =>
      ready({ nodeId: 'PR_node', mergeQueue: { enabled: true }, ...overrides });
    const armed: PrBinding = { ...bound, autoMerge: true, autoMergeMode: 'desktop' };

    it('enqueues on refresh, straight from that read, and never merges directly', async () => {
      const { store, fake, out, monitor, pushed } = setup(queued());
      await store.set(SESSION, armed);
      await monitor.refresh(SESSION);
      expect(fake.calls.filter(call => call.startsWith('enqueue:') || call.startsWith('merge:'))).toEqual([
        'enqueue:PR_node:sha-ready',
      ]);
      expect((await store.get(SESSION))?.mergeQueuedAt).toEqual(expect.any(String));
      expect(out.last()?.autoMerge).toMatchObject({
        mode: 'desktop',
        queued: { position: 1 },
        note: expect.stringMatching(/Queued to merge \(position 1\)/),
      });
      // The read GitHub answered had no queue entry, so only the app's own enqueue turns the row amber.
      expect(pushed[pushed.length - 1]?.summary?.state).toBe('queued');
      monitor.dispose();
    });

    it('still merges directly on a base without a queue', async () => {
      const { store, fake, monitor } = setup(ready({ mergeQueue: { enabled: false } }));
      await store.set(SESSION, armed);
      await monitor.refresh(SESSION);
      expect(fake.calls.filter(call => call.startsWith('enqueue:') || call.startsWith('merge:'))).toEqual([
        'merge:squash:sha-ready',
      ]);
      monitor.dispose();
    });

    it('shows a refused enqueue in place of a waiting note, and stops', async () => {
      const { store, fake, out, monitor } = setup(queued());
      await store.set(SESSION, armed);
      fake.github.enqueue = async () => {
        throw new GhError('failed', 'Pull request is not mergeable');
      };
      await monitor.refresh(SESSION);
      const binding = await store.get(SESSION);
      expect(binding?.autoMerge).toBe(false);
      expect(binding?.mergeQueuedAt).toBeUndefined();
      expect(out.last()?.autoMerge).toEqual({
        mode: null,
        error: 'Auto-merge stopped: GitHub would not queue it: Pull request is not mergeable',
      });
      monitor.dispose();
    });

    it('treats a queued PR as merging, reads why it left, and does not queue it again', async () => {
      const { store, fake, out, monitor } = setup(
        queued({ mergeQueue: { enabled: true, entry: { state: 'AWAITING_CHECKS', position: 2 } } })
      );
      await store.set(SESSION, { ...armed, mergeQueuedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
      await monitor.refresh(SESSION);
      expect(out.last()?.autoMerge).toMatchObject({ queued: { position: 2 }, note: 'Queued to merge (position 2).' });
      expect(fake.calls).toContain('snapshot+queue');
      expect(await monitor.setOption(SESSION, 'autoMerge', false)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/merge queue/),
      });

      fake.answer(
        queued({
          mergeQueue: {
            enabled: true,
            removed: { at: new Date().toISOString(), reason: 'Required status check failed' },
          },
        })
      );
      await monitor.refresh(SESSION);
      expect(fake.calls.some(call => call.startsWith('enqueue:'))).toBe(false);
      expect((await store.get(SESSION))?.autoMerge).toBe(false);
      expect(out.last()?.autoMerge).toEqual({
        mode: null,
        error: 'Auto-merge stopped: the merge queue removed this PR: Required status check failed',
      });
      monitor.dispose();
    });

    it('waits out GitHub catching up right after the enqueue', async () => {
      const { store, fake, out, monitor } = setup(queued());
      await store.set(SESSION, { ...armed, mergeQueuedAt: new Date().toISOString() });
      await monitor.refresh(SESSION);
      expect((await store.get(SESSION))?.autoMerge).toBe(true);
      expect(out.last()?.autoMerge.note).toBe('Queued to merge.');
      expect(fake.calls.some(call => call.startsWith('enqueue:'))).toBe(false);
      monitor.dispose();
    });

    it('clears the queue mark once the PR has merged', async () => {
      const { store, monitor } = setup(queued({ state: 'MERGED' }));
      await store.set(SESSION, { ...armed, mergeQueuedAt: new Date().toISOString() });
      await monitor.refresh(SESSION);
      const binding = await store.get(SESSION);
      expect(binding?.autoMerge).toBe(false);
      expect(binding?.mergeQueuedAt).toBeUndefined();
      monitor.dispose();
    });
  });
});

describe('auto-archive', () => {
  const SESSION = 'session-1';
  const bound: PrBinding = { ...REF, source: 'shell', boundAt: '' };

  function setup() {
    const store = tempStore();
    const fake = fakeGithub();
    const archived: string[] = [];
    const monitor = new PrMonitor({
      store,
      github: fake.github,
      chat: {
        isCode: async () => true,
        project: async () => null,
        archive: async sessionId => {
          archived.push(sessionId);
        },
        isBusy: () => false,
        startAutoFix: async () => ({ ok: false as const, busy: true, error: 'busy' }),
      },
      emit: collector().emit,
      logger: quietLogger,
      batchWindowMs: 0,
    });
    return { store, fake, archived, monitor };
  }

  describe('shouldAutoArchive', () => {
    it('fires only on the open -> merged/closed transition, with the option on, once', () => {
      const on = { ...bound, autoArchive: true, lastState: 'OPEN' as const };
      expect(shouldAutoArchive(on, 'MERGED')).toBe(true);
      expect(shouldAutoArchive(on, 'CLOSED')).toBe(true);
      expect(shouldAutoArchive(on, 'OPEN')).toBe(false);
      expect(shouldAutoArchive({ ...on, autoArchive: false }, 'MERGED')).toBe(false);
      expect(shouldAutoArchive({ ...on, lastState: undefined }, 'MERGED')).toBe(false);
      expect(shouldAutoArchive({ ...on, lastState: 'MERGED' }, 'MERGED')).toBe(false);
      expect(shouldAutoArchive({ ...on, archivedOnClose: true }, 'CLOSED')).toBe(false);
    });
  });

  describe('PrMonitor auto-archive', () => {
    it('archives when an open PR it is watching merges, and never again', async () => {
      const { store, fake, archived, monitor } = setup();
      await store.set(SESSION, bound);
      await monitor.refresh(SESSION);
      expect(await monitor.setOption(SESSION, 'autoArchive', true)).toEqual({ ok: true });

      fake.answer(snapshot({ state: 'MERGED' }));
      await monitor.refresh(SESSION);
      expect(archived).toEqual([SESSION]);
      expect(await store.get(SESSION)).toMatchObject({ archivedOnClose: true, lastState: 'MERGED' });

      // The user unarchives; later reads must not archive it again.
      await monitor.refresh(SESSION);
      expect(archived).toEqual([SESSION]);
      monitor.dispose();
    });

    it('does not archive a PR that was already merged when it was bound', async () => {
      const { store, fake, archived, monitor } = setup();
      await store.set(SESSION, { ...bound, autoArchive: true });
      fake.answer(snapshot({ state: 'MERGED' }));
      await monitor.refresh(SESSION);
      expect(archived).toEqual([]);
    });

    it('does not archive with the option off', async () => {
      const { store, fake, archived, monitor } = setup();
      await store.set(SESSION, { ...bound, lastState: 'OPEN' });
      fake.answer(snapshot({ state: 'CLOSED' }));
      await monitor.refresh(SESSION);
      expect(archived).toEqual([]);
    });
  });
});

describe('poll schedule', () => {
  const base: PollInput = {
    state: 'OPEN',
    dismissed: false,
    onScreen: true,
    opened: true,
    armed: false,
    active: true,
    failures: 0,
  };

  describe('pollDelay', () => {
    it('reads the PR on screen often while checks run, less once settled', () => {
      expect(pollDelay(base)).toBe(POLL_MS.onScreenActive);
      expect(pollDelay({ ...base, active: false })).toBe(POLL_MS.onScreenSettled);
    });

    it('reads a conversation opened earlier much less often', () => {
      expect(pollDelay({ ...base, onScreen: false })).toBe(POLL_MS.openedActive);
      expect(pollDelay({ ...base, onScreen: false, active: false })).toBe(POLL_MS.openedSettled);
    });

    it('never reads an unopened conversation unless something is armed on it', () => {
      expect(pollDelay({ ...base, onScreen: false, opened: false })).toBeNull();
      expect(pollDelay({ ...base, onScreen: false, opened: false, armed: true })).toBe(POLL_MS.unopenedArmed);
    });

    it('stops entirely once the PR is merged or closed, whatever else is true', () => {
      expect(pollDelay({ ...base, state: 'MERGED', armed: true })).toBeNull();
      expect(pollDelay({ ...base, state: 'CLOSED', armed: true })).toBeNull();
    });

    it('stops for a dismissed bar with nothing armed', () => {
      expect(pollDelay({ ...base, dismissed: true })).toBeNull();
    });

    it('backs off exponentially on failures, from a floor, up to a cap', () => {
      expect(pollDelay({ ...base, failures: 1 })).toBe(POLL_MS.backoffFloor * 2);
      expect(pollDelay({ ...base, failures: 2 })).toBe(POLL_MS.backoffFloor * 4);
      expect(pollDelay({ ...base, failures: 50 })).toBe(POLL_MS.maxBackoff);
      expect(pollDelay({ ...base, onScreen: false, active: false, failures: 1 })).toBe(POLL_MS.openedSettled * 2);
    });
  });

  describe('alignToTick', () => {
    it('stretches a delay to end on the next grid line, never by a full tick or more', () => {
      expect(alignToTick(0, 30_000)).toBe(30_000);
      expect(alignToTick(4_000, 30_000)).toBe(41_000);
      expect(alignToTick(4_000, 2_000)).toBe(11_000);
      expect(alignToTick(990_000, 0)).toBe(0);
    });
  });
});

describe('binding store', () => {
  const SESSION = 'session-1';

  function storeWith(binding: unknown): PrBindingStore {
    const path = join(mkdtempSync(join(tmpdir(), 'b4m-pr-')), 'pull-requests.json');
    writeFileSync(path, JSON.stringify({ [SESSION]: binding }));
    return new PrBindingStore(path);
  }

  const raw = { ...REF, source: 'shell', boundAt: '', lastState: 'OPEN', autoFix: true };

  describe('PrBindingStore auto-fix budget', () => {
    it('keeps a whole positive budget', async () => {
      expect((await storeWith({ ...raw, autoFixMax: 5 }).get(SESSION))?.autoFixMax).toBe(5);
    });

    it('keeps a saved budget above the current Settings maximum', async () => {
      expect((await storeWith({ ...raw, autoFixMax: 21 }).get(SESSION))?.autoFixMax).toBe(21);
    });

    it.each([
      ['a string', 'x'],
      ['zero', 0],
      ['a negative number', -1],
      ['a fraction', 2.5],
    ])('drops %s so the legacy fallback applies', async (_label, autoFixMax) => {
      expect((await storeWith({ ...raw, autoFixMax }).get(SESSION))?.autoFixMax).toBeUndefined();
    });
  });

  describe('PrBindingStore.updateEach', () => {
    it('changes only the bindings it answers for, in one write', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'b4m-pr-')), 'pull-requests.json');
      writeFileSync(path, JSON.stringify({ a: { ...raw, autoFixMax: 2 }, b: { ...raw, autoFix: false } }));
      const store = new PrBindingStore(path);
      const changed = await store.updateEach(binding => (binding.autoFix ? { ...binding, autoFixMax: 7 } : null));
      expect(changed).toEqual(['a']);
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { autoFixMax?: number }>;
      expect(saved.a.autoFixMax).toBe(7);
      expect(saved.b.autoFixMax).toBeUndefined();
    });

    it('writes nothing when nothing changes', async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'b4m-pr-')), 'pull-requests.json');
      const original = JSON.stringify({ a: raw });
      writeFileSync(path, original);
      expect(await new PrBindingStore(path).updateEach(() => null)).toEqual([]);
      expect(readFileSync(path, 'utf8')).toBe(original);
    });
  });
});

describe('auto-fix planning', () => {
  const binding: PrBinding = {
    ...REF,
    source: 'shell',
    boundAt: '',
    autoFix: true,
    autoFixMax: DEFAULT_AUTO_FIX_ATTEMPTS,
    lastState: 'OPEN',
  };

  function thread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
    return {
      id: 'thread-1',
      path: 'src/ladder.ts',
      line: 12,
      commentId: 901,
      author: 'reviewer',
      association: 'MEMBER',
      body: 'Please handle the empty ladder.',
      url: 'https://github.com/example-org/widgets/pull/611#discussion_r901',
      outdated: false,
      ...overrides,
    };
  }

  function changeRequest(overrides: Partial<PrChangeRequest> = {}): PrChangeRequest {
    return {
      reviewId: 77,
      author: 'reviewer',
      association: 'MEMBER',
      body: 'Verdict: request changes. The ladder breaks on an empty list.',
      url: 'https://github.com/example-org/widgets/pull/611#pullrequestreview-77',
      ...overrides,
    };
  }

  const failing = snapshot({ headSha: 'sha-bad', checks: [check('Build', 'fail'), check('Lint', 'pass')] });

  describe('planAutoFix', () => {
    it('starts a turn for a settled failing run, keyed by the head commit', () => {
      const plan = planAutoFix(binding, failing, false);
      expect(plan.kind).toBe('start');
      if (plan.kind !== 'start') return;
      expect(plan.fingerprints).toEqual(['ci:sha-bad']);
      expect(plan.summary).toBe('1 failing check on #611');
      expect(plan.prompt).toContain(`Attempt 1 of ${DEFAULT_AUTO_FIX_ATTEMPTS}`);
      expect(plan.prompt).toContain('Never force-push');
    });

    it('waits while any check is still running', () => {
      const running = snapshot({ checks: [check('Build', 'fail'), check('Test', 'pending')] });
      expect(planAutoFix(binding, running, false)).toEqual({ kind: 'none' });
    });

    it('does not act on the same failing run twice', () => {
      expect(planAutoFix({ ...binding, autoFixHandled: ['ci:sha-bad'] }, failing, false)).toEqual({ kind: 'none' });
    });

    it('acts again once a new commit fails', () => {
      const plan = planAutoFix(
        { ...binding, autoFixHandled: ['ci:sha-bad'] },
        { ...failing, headSha: 'sha-next' },
        false
      );
      expect(plan.kind === 'start' && plan.fingerprints).toEqual(['ci:sha-next']);
    });

    it('gives up after the attempt limit', () => {
      expect(planAutoFix({ ...binding, autoFixAttempts: DEFAULT_AUTO_FIX_ATTEMPTS }, failing, false)).toEqual({
        kind: 'exhausted',
      });
    });

    it('gives a binding ticked for the new budget five attempts', () => {
      const last = planAutoFix({ ...binding, autoFixAttempts: 4 }, failing, false);
      expect(last.kind === 'start' && last.prompt).toContain('Attempt 5 of 5');
      expect(planAutoFix({ ...binding, autoFixAttempts: 5 }, failing, false)).toEqual({ kind: 'exhausted' });
    });

    it('keeps a binding ticked before the budget was stored at three attempts', () => {
      const { autoFixMax: _, ...legacy } = binding;
      expect(planAutoFix({ ...legacy, autoFixAttempts: 3 }, failing, false)).toEqual({ kind: 'exhausted' });
      const plan = planAutoFix({ ...legacy, autoFixAttempts: 2 }, failing, false);
      expect(plan.kind === 'start' && plan.prompt).toContain('Attempt 3 of 3');
    });

    it('waits for a running turn instead of starting one', () => {
      expect(planAutoFix(binding, failing, true)).toEqual({ kind: 'wait' });
    });

    it('does nothing when the box is off or the PR is no longer open', () => {
      expect(planAutoFix({ ...binding, autoFix: false }, failing, false)).toEqual({ kind: 'none' });
      expect(planAutoFix(binding, { ...failing, state: 'MERGED' }, false)).toEqual({ kind: 'none' });
    });

    it('acts on a new comment once, keyed by its id', () => {
      const withComment = snapshot({ threads: [thread()] });
      const plan = planAutoFix(binding, withComment, false);
      expect(plan.kind === 'start' && plan.fingerprints).toEqual(['comment:901']);
      expect(plan.kind === 'start' && plan.prompt).toContain('    > Please handle the empty ladder.');
      expect(planAutoFix({ ...binding, autoFixHandled: ['comment:901'] }, withComment, false)).toEqual({
        kind: 'none',
      });
    });

    it('acts once on a review requesting changes with no inline comments', () => {
      const reviewed = snapshot({ reviewDecision: 'CHANGES_REQUESTED', changeRequests: [changeRequest()] });
      const plan = planAutoFix(binding, reviewed, false);
      expect(plan.kind).toBe('start');
      if (plan.kind !== 'start') return;
      expect(plan.fingerprints).toEqual(['review:77']);
      expect(plan.summary).toBe('1 change request on #611');
      expect(plan.prompt).toContain('    > Verdict: request changes.');
      expect(planAutoFix({ ...binding, autoFixHandled: ['review:77'] }, reviewed, false)).toEqual({ kind: 'none' });
    });

    it.each([
      ['by someone without write access', changeRequest({ author: 'drive-by', association: 'NONE' })],
      ['by the viewer', changeRequest({ author: 'octo-dev', association: 'OWNER' })],
      ['with no body', changeRequest({ body: ' ' })],
    ])('ignores a change request %s', (_label, ignored) => {
      expect(planAutoFix(binding, snapshot({ changeRequests: [ignored] }), false)).toEqual({ kind: 'none' });
    });

    it.each([
      ['an outdated comment', thread({ outdated: true })],
      ['a comment by the viewer', thread({ author: 'octo-dev', association: 'OWNER' })],
      ['a comment by someone without write access', thread({ author: 'drive-by', association: 'NONE' })],
      ['an empty comment', thread({ body: '   ' })],
    ])('ignores %s', (_label, ignored) => {
      expect(planAutoFix(binding, snapshot({ threads: [ignored] }), false)).toEqual({ kind: 'none' });
    });

    it("acts on the PR author's own comments even without write access", () => {
      const authored = snapshot({
        viewer: 'someone-else',
        threads: [thread({ author: 'octo-dev', association: 'NONE' })],
      });
      expect(planAutoFix(binding, authored, false).kind).toBe('start');
    });
  });

  describe('planAutoFix on merge conflicts', () => {
    const conflicting = snapshot({ headSha: 'sha-head', baseSha: 'sha-base', mergeable: 'CONFLICTING' });

    it('starts a turn for a conflicting PR, keyed by head and base', () => {
      const plan = planAutoFix(binding, conflicting, false);
      expect(plan.kind).toBe('start');
      if (plan.kind !== 'start') return;
      expect(plan.fingerprints).toEqual(['conflict:sha-head:sha-base']);
      expect(plan.summary).toBe('merge conflicts on #611');
      expect(plan.prompt).toContain('git fetch origin main');
      expect(plan.prompt).toContain('MERGE `origin/main`');
      expect(plan.prompt).toContain('Do not rebase.');
      expect(plan.prompt).toContain('never `git add -A`');
      expect(plan.prompt).toContain('do not guess');
      expect(plan.prompt).toContain('Never force-push');
    });

    it('does not act while GitHub is still computing mergeability', () => {
      expect(planAutoFix(binding, { ...conflicting, mergeable: 'UNKNOWN' }, false)).toEqual({ kind: 'none' });
    });

    it('does not act twice on the same head and base', () => {
      const handled = { ...binding, autoFixHandled: ['conflict:sha-head:sha-base'] };
      expect(planAutoFix(handled, conflicting, false)).toEqual({ kind: 'none' });
    });

    it('acts again once the base branch moves', () => {
      const handled = { ...binding, autoFixHandled: ['conflict:sha-head:sha-base'] };
      const plan = planAutoFix(handled, { ...conflicting, baseSha: 'sha-base-2' }, false);
      expect(plan.kind === 'start' && plan.fingerprints).toEqual(['conflict:sha-head:sha-base-2']);
    });

    it('puts the conflict first when comments and failing checks come with it', () => {
      const plan = planAutoFix(
        binding,
        { ...conflicting, checks: [check('Build', 'fail')], threads: [thread()] },
        false
      );
      expect(plan.kind).toBe('start');
      if (plan.kind !== 'start') return;
      expect(plan.fingerprints).toEqual(['conflict:sha-head:sha-base', 'ci:sha-head', 'comment:901']);
      expect(plan.summary).toBe('merge conflicts and 1 failing check and 1 new review comment on #611');
      const conflictAt = plan.prompt.indexOf('merge conflicts with its base branch');
      expect(conflictAt).toBeGreaterThan(-1);
      expect(conflictAt).toBeLessThan(plan.prompt.indexOf('These checks failed'));
      expect(conflictAt).toBeLessThan(plan.prompt.indexOf('New review comments'));
    });

    it('counts against the attempt limit', () => {
      expect(planAutoFix({ ...binding, autoFixAttempts: DEFAULT_AUTO_FIX_ATTEMPTS }, conflicting, false)).toEqual({
        kind: 'exhausted',
      });
    });

    it('waits for a running turn', () => {
      expect(planAutoFix(binding, conflicting, true)).toEqual({ kind: 'wait' });
    });
  });

  describe('autoFixRefusal', () => {
    it.each([
      'git push --force',
      'git push -f origin feat/widget-ladder',
      'git push --force-with-lease',
      'git push origin +feat/widget-ladder',
      'git add . && git push --force',
      'gh pr merge 611 --squash',
      'gh api repos/example-org/widgets/pulls/611/merge -X PUT',
    ])('refuses %s', command => {
      expect(autoFixRefusal(command)).not.toBeNull();
    });

    it.each([
      'git push',
      'git push -u origin feat/widget-ladder',
      'git commit -m "fix" && git push',
      'gh pr checks 611',
    ])('allows %s', command => {
      expect(autoFixRefusal(command)).toBeNull();
    });
  });

  describe('autoFixToolRefusal', () => {
    it('refuses handing the work to another conversation', () => {
      expect(autoFixToolRefusal('session_spawn', { prompt: 'git push --force' })).not.toBeNull();
      expect(autoFixToolRefusal('session_send', { text: 'merge it' })).not.toBeNull();
    });

    it('refuses changing which PR the session follows', () => {
      expect(autoFixToolRefusal('set_session_pull_request', { pull_request: '#9' })).not.toBeNull();
    });

    it('checks shell commands and leaves other tools alone', () => {
      expect(autoFixToolRefusal('bash_execute', { command: 'git push -f' })).not.toBeNull();
      expect(autoFixToolRefusal('bash_execute', { command: 'git push' })).toBeNull();
      expect(autoFixToolRefusal('file_write', { path: 'a.ts' })).toBeNull();
    });
  });
});

describe('auto-fix attempts setting', () => {
  async function setup(stored?: string) {
    const file = join(await mkdtemp(join(tmpdir(), 'b4m-auto-fix-attempts-')), 'auto-fix-attempts.json');
    if (stored !== undefined) await writeFile(file, stored);
    const apply = vi.fn(async (_attempts: number) => undefined);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerAutoFixAttemptsIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      { preference: new AutoFixAttemptsPreference(file), apply }
    );
    const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({ sender: {} }, ...args);
    return { file, apply, call };
  }

  describe('registerAutoFixAttemptsIpc', () => {
    it('answers five when nothing is stored', async () => {
      const { call } = await setup();
      expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(5);
    });

    it('saves a value in range and hands it to the PR monitor', async () => {
      const { file, apply, call } = await setup();
      expect(await call(IPC_CHANNELS.prSetAutoFixAttempts, 2)).toBe(2);
      expect(apply).toHaveBeenCalledWith(2);
      expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(2);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ attempts: 2 });
    });

    it.each([null, '3', 0, 21, 2.5, { attempts: 3 }])('saves garbage from the renderer as five: %j', async input => {
      const { apply, call } = await setup();
      expect(await call(IPC_CHANNELS.prSetAutoFixAttempts, input)).toBe(5);
      expect(apply).toHaveBeenCalledWith(5);
    });

    it.each(['not json', '{"attempts":99}', '{"attempts":"4"}', '7'])('reads a damaged file as five: %s', async raw => {
      const { call } = await setup(raw);
      expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(5);
    });

    it('rejects and skips the monitor when the value cannot be saved', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'b4m-auto-fix-attempts-'));
      const blocker = join(dir, 'file');
      await writeFile(blocker, '');
      const apply = vi.fn(async (_attempts: number) => undefined);
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      registerAutoFixAttemptsIpc(
        {
          handle: (channel: string, listener: (...args: never[]) => unknown) =>
            void handlers.set(channel, listener as never),
        },
        { preference: new AutoFixAttemptsPreference(join(blocker, 'auto-fix-attempts.json')), apply }
      );
      await expect(handlers.get(IPC_CHANNELS.prSetAutoFixAttempts)?.({ sender: {} }, 2)).rejects.toThrow();
      expect(apply).not.toHaveBeenCalled();
      expect(await handlers.get(IPC_CHANNELS.prGetAutoFixAttempts)?.({ sender: {} })).toBe(5);
    });

    it('still answers saved when the monitor fails to apply the value', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { apply, call } = await setup();
      apply.mockRejectedValueOnce(new Error('disk full'));
      expect(await call(IPC_CHANNELS.prSetAutoFixAttempts, 8)).toBe(8);
      expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(8);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('reads a stored value back after a restart', async () => {
      const { call } = await setup('{"attempts":12}');
      expect(await call(IPC_CHANNELS.prGetAutoFixAttempts)).toBe(12);
    });
  });
});

describe('GitHub reads', () => {
  const REF: PrRef = {
    owner: 'example-org',
    repo: 'widgets',
    number: 611,
    url: 'https://github.com/example-org/widgets/pull/611',
  };

  /** The shape `gh api graphql` returned for a real open PR, trimmed and renamed. */
  function response(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        viewer: { login: 'octo-dev' },
        repository: {
          autoMergeAllowed: false,
          squashMergeAllowed: true,
          mergeCommitAllowed: true,
          rebaseMergeAllowed: false,
          viewerDefaultMergeMethod: 'MERGE',
          pullRequest: {
            number: 611,
            title: 'feat: <b>ladder</b>',
            url: REF.url,
            state: 'OPEN',
            isDraft: false,
            author: { login: 'octo-dev' },
            headRefName: 'feat/widget-ladder',
            headRefOid: 'abc123',
            baseRefName: 'main',
            baseRefOid: 'def456',
            additions: 157,
            deletions: 0,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BLOCKED',
            reviewDecision: 'REVIEW_REQUIRED',
            autoMergeRequest: null,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          {
                            __typename: 'CheckRun',
                            name: 'Build',
                            status: 'IN_PROGRESS',
                            conclusion: null,
                            detailsUrl: 'https://github.com/example-org/widgets/actions/runs/1/job/2',
                            isRequired: true,
                            checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
                          },
                          {
                            __typename: 'CheckRun',
                            name: 'Lint',
                            status: 'COMPLETED',
                            conclusion: 'SUCCESS',
                            isRequired: false,
                          },
                          {
                            __typename: 'CheckRun',
                            name: 'Unit',
                            status: 'COMPLETED',
                            conclusion: 'FAILURE',
                            isRequired: true,
                          },
                          {
                            __typename: 'CheckRun',
                            name: 'E2E',
                            status: 'COMPLETED',
                            conclusion: 'SKIPPED',
                            isRequired: false,
                          },
                          {
                            __typename: 'StatusContext',
                            context: 'deploy/preview',
                            state: 'PENDING',
                            isRequired: false,
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
            ...overrides,
          },
        },
      },
    };
  }

  describe('parseSnapshot', () => {
    it('reads the fields the bar draws and buckets every check', () => {
      const snapshot = parseSnapshot(REF, response(), 1000, false);
      expect(snapshot).toMatchObject({
        number: 611,
        title: 'feat: <b>ladder</b>',
        headRefName: 'feat/widget-ladder',
        headSha: 'abc123',
        baseRefName: 'main',
        baseSha: 'def456',
        additions: 157,
        deletions: 0,
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        reviewDecision: 'REVIEW_REQUIRED',
        autoMergeArmed: false,
        viewer: 'octo-dev',
        fetchedAt: 1000,
      });
      expect(snapshot.checks.map(check => [check.name, check.bucket, check.required])).toEqual([
        ['Build', 'pending', true],
        ['Lint', 'pass', false],
        ['Unit', 'fail', true],
        ['E2E', 'skipped', false],
        ['deploy/preview', 'pending', false],
      ]);
      expect(snapshot.checks[0]).toMatchObject({ workflow: 'CI', url: expect.stringContaining('/actions/runs/1') });
      expect(snapshot.threads).toBeUndefined();
    });

    it('records the repo merge settings, preferring the viewer default when allowed', () => {
      const snapshot = parseSnapshot(REF, response(), 0, false);
      expect(snapshot.repoSettings).toEqual({
        autoMergeAllowed: false,
        allowedMethods: ['squash', 'merge'],
        defaultMethod: 'merge',
      });
      expect(mergeMethodFor(snapshot)).toBe('merge');
    });

    it('reads armed auto-merge and a merged state', () => {
      const snapshot = parseSnapshot(
        REF,
        response({ state: 'MERGED', autoMergeRequest: { enabledAt: 'x' } }),
        0,
        false
      );
      expect(snapshot.state).toBe('MERGED');
      expect(snapshot.autoMergeArmed).toBe(true);
    });

    it('keeps only unresolved threads, reduced to their latest comment', () => {
      const raw = response({
        reviewThreads: {
          nodes: [
            { id: 't1', isResolved: true, comments: { nodes: [{ databaseId: 1, body: 'done' }] } },
            {
              id: 't2',
              isResolved: false,
              isOutdated: false,
              path: 'src/a.ts',
              line: 12,
              comments: {
                nodes: [
                  {
                    databaseId: 2,
                    author: { login: 'reviewer' },
                    authorAssociation: 'MEMBER',
                    body: 'rename',
                    url: 'u',
                  },
                ],
              },
            },
          ],
        },
      });
      expect(parseSnapshot(REF, raw, 0, true).threads).toEqual([
        {
          id: 't2',
          path: 'src/a.ts',
          line: 12,
          commentId: 2,
          author: 'reviewer',
          association: 'MEMBER',
          body: 'rename',
          url: 'u',
          outdated: false,
        },
      ]);
    });

    it("keeps each reviewer's latest review only while it requests changes", () => {
      const raw = response({
        latestReviews: {
          nodes: [
            {
              databaseId: 5,
              state: 'APPROVED',
              author: { login: 'a' },
              authorAssociation: 'MEMBER',
              body: 'ok',
              url: 'u5',
            },
            {
              databaseId: 6,
              state: 'CHANGES_REQUESTED',
              author: { login: 'b' },
              authorAssociation: 'MEMBER',
              body: 'fix it',
              url: 'u6',
            },
          ],
        },
      });
      expect(parseSnapshot(REF, raw, 0, true).changeRequests).toEqual([
        { reviewId: 6, author: 'b', association: 'MEMBER', body: 'fix it', url: 'u6' },
      ]);
      expect(parseSnapshot(REF, raw, 0, false).changeRequests).toBeUndefined();
    });

    it('reports a PR the repo does not have as not-found', () => {
      expect(() => parseSnapshot(REF, { data: { repository: { pullRequest: null } } }, 0, false)).toThrow(GhError);
    });
  });

  describe('PrGithub', () => {
    it('never passes --admin and pins a merge to the head it checked', async () => {
      const gh = vi.fn().mockResolvedValue('');
      const github = new PrGithub(gh);
      await github.merge(REF, 'squash', 'abc123');
      await github.enableAutoMerge(REF, 'merge');
      await github.disableAutoMerge(REF);
      const calls = gh.mock.calls.map(([args]) => (args as string[]).join(' '));
      expect(calls).toEqual([
        `pr merge ${REF.url} --squash --match-head-commit abc123`,
        `pr merge ${REF.url} --auto --merge`,
        `pr merge ${REF.url} --disable-auto`,
      ]);
      expect(calls.join(' ')).not.toContain('--admin');
    });

    it('passes the owner and repo as strings', async () => {
      const gh = vi.fn().mockResolvedValue(JSON.stringify(batched(repository())));
      await new PrGithub(gh).snapshot(REF, { threads: false });
      const args = gh.mock.calls[0][0] as string[];
      expect(args[args.indexOf('o0=example-org') - 1]).toBe('-f');
      expect(args[args.indexOf('n0=widgets') - 1]).toBe('-f');
      expect(args).toContain('t0=false');
    });

    it('reads several pull requests in one gh call', async () => {
      const gh = vi.fn().mockResolvedValue(JSON.stringify(batched(repository(), repository({ number: 612 }))));
      const results = await new PrGithub(gh).snapshots([
        { ref: REF, threads: false },
        { ref: OTHER, threads: true },
      ]);
      expect(gh).toHaveBeenCalledTimes(1);
      expect(results.map(result => (result instanceof GhError ? result.kind : result.number))).toEqual([611, 612]);
      expect((results[1] as { threads?: unknown[] }).threads).toEqual([]);
      const args = gh.mock.calls[0][0] as string[];
      expect(args).toEqual(expect.arrayContaining(['p0=611', 'p1=612', 't0=false', 't1=true']));
    });

    it('keeps the other answers when one pull request cannot be read', async () => {
      const body = {
        ...batched(repository(), { pullRequest: null }),
        errors: [{ type: 'NOT_FOUND', path: ['p1', 'pullRequest'], message: 'Could not resolve to a PullRequest.' }],
      };
      const gh = vi.fn().mockRejectedValue(new GhError('not-found', 'Could not resolve', JSON.stringify(body)));
      const [first, second] = await new PrGithub(gh).snapshots([
        { ref: REF, threads: false },
        { ref: OTHER, threads: false },
      ]);
      expect(first).toMatchObject({ number: 611, state: 'OPEN' });
      expect(second).toBeInstanceOf(GhError);
      expect((second as GhError).kind).toBe('not-found');
    });

    it('fails every pull request in the call when gh itself fails', async () => {
      const gh = vi.fn().mockRejectedValue(new GhError('unauthenticated', 'run gh auth login'));
      await expect(new PrGithub(gh).snapshots([{ ref: REF, threads: false }])).rejects.toMatchObject({
        kind: 'unauthenticated',
      });
    });

    describe('findOpenForBranch', () => {
      const LIST = ['pr', 'list', '--head', 'feat/x', '--state', 'open', '--json', 'url', '--limit', '1'];
      const WSL = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo';

      const AUTH = ['auth', 'status', '--hostname'];
      const listing = (signedInTo: string[] = []) =>
        vi.fn(async (args: readonly string[]) => {
          if (args[0] !== 'auth') return JSON.stringify([{ url: REF.url }]);
          if (signedInTo.includes(args[3] ?? '')) return '';
          throw new GhError('failed', 'not logged in');
        });
      const lookUp = (
        gh: ReturnType<typeof listing>,
        settings: string | null,
        aliases: Record<string, string> = {}
      ) => {
        const remotes = vi.fn().mockResolvedValue(settings);
        const ssh = vi.fn(async (_directory: string, alias: string) => aliases[alias] ?? null);
        return {
          remotes,
          ssh,
          found: new PrGithub(gh, Date.now, remotes, 'win32', ssh).findOpenForBranch(WSL, 'feat/x'),
        };
      };
      const repoOf = (gh: ReturnType<typeof listing>) => {
        const listed = gh.mock.calls.map(([args]) => args).find(args => args[0] === 'pr');
        return listed?.[listed.indexOf('--repo') + 1];
      };

      it('names the repo from the distro origin for a WSL project and runs gh outside the folder', async () => {
        const gh = listing();
        const { remotes, found } = lookUp(gh, 'remote.origin.url git@github.com:example-org/widgets.git');

        expect(await found).toBe(REF.url);
        expect(remotes).toHaveBeenCalledWith(WSL);
        expect(gh.mock.calls).toEqual([[[...LIST, '--repo', 'github.com/example-org/widgets']]]);
      });

      it('aims at upstream in a fork checkout, where the pull request lives', async () => {
        const gh = listing();
        const { found } = lookUp(
          gh,
          [
            'remote.origin.url git@github.com:me/widgets.git',
            'remote.upstream.url https://github.com/example-org/widgets.git',
          ].join('\n')
        );

        await found;
        expect(repoOf(gh)).toBe('github.com/example-org/widgets');
      });

      it('aims at the remote gh was told to default to, ahead of upstream', async () => {
        const marked = listing();
        await lookUp(
          marked,
          [
            'remote.origin.url git@github.com:me/widgets.git',
            'remote.mirror.url git@github.com:team/widgets.git',
            'remote.upstream.url https://github.com/example-org/widgets.git',
            'remote.mirror.gh-resolved base',
          ].join('\n')
        ).found;
        expect(repoOf(marked)).toBe('github.com/team/widgets');

        const named = listing();
        await lookUp(
          named,
          [
            'remote.origin.url git@github.com:me/widgets.git',
            'remote.upstream.url https://github.com/example-org/widgets.git',
            'remote.origin.gh-resolved other-org/gadgets',
          ].join('\n')
        ).found;
        expect(repoOf(named)).toBe('github.com/other-org/gadgets');
      });

      it('reads GitHub proxy names as github.com without asking gh or ssh', async () => {
        for (const url of [
          'ssh://git@ssh.github.com:443/example-org/widgets.git',
          'https://www.github.com/example-org/widgets',
        ]) {
          const gh = listing();
          const { ssh, found } = lookUp(gh, `remote.origin.url ${url}`);
          await found;
          expect(gh.mock.calls).toEqual([[[...LIST, '--repo', 'github.com/example-org/widgets']]]);
          expect(ssh).not.toHaveBeenCalled();
        }
      });

      it('follows an SSH host alias to the host its ssh config names', async () => {
        const gh = listing(['git.example.com']);
        const { ssh, found } = lookUp(gh, 'remote.origin.url git@github-work:example-org/widgets.git', {
          'github-work': 'github.com',
        });
        await found;
        expect(ssh).toHaveBeenCalledWith(WSL, 'github-work');
        expect(repoOf(gh)).toBe('github.com/example-org/widgets');

        const enterprise = listing(['git.example.com']);
        await lookUp(enterprise, 'remote.origin.url git@work-ghe:team/widgets.git', { 'work-ghe': 'git.example.com' })
          .found;
        expect(repoOf(enterprise)).toBe('git.example.com/team/widgets');
      });

      it('aims at a remote on a server gh is signed in to, under that host', async () => {
        const gh = listing(['git.example.com']);
        await lookUp(gh, 'remote.origin.url https://git.example.com/team/widgets.git').found;

        expect(gh.mock.calls[0]?.[0]).toEqual([...AUTH, 'git.example.com']);
        expect(repoOf(gh)).toBe('git.example.com/team/widgets');
      });

      it('never sends a remote on a host gh cannot use to another host', async () => {
        const both = listing();
        await lookUp(
          both,
          [
            'remote.origin.url git@github.com:me/widgets.git',
            'remote.upstream.url git@gitlab.com:team/widgets.git',
          ].join('\n')
        ).found;
        expect(repoOf(both)).toBe('github.com/me/widgets');

        for (const settings of [
          'remote.origin.url https://git.example.com/team/widgets.git',
          'remote.origin.url git@gitlab.com:team/widgets.git',
          'remote.origin.url git@unknown-alias:team/widgets.git',
        ]) {
          const gh = listing();
          expect(await lookUp(gh, settings, { 'unknown-alias': 'gitlab.com' }).found).toBeNull();
          expect(repoOf(gh)).toBeUndefined();
        }
      });

      it('finds no host gh is signed in to when gh cannot say', async () => {
        const gh = vi.fn(async (args: readonly string[]) => {
          if (args[0] === 'auth') throw new GhError('failed', 'unknown flag');
          return '[]';
        });
        expect(await lookUp(gh, 'remote.origin.url https://git.example.com/team/widgets.git').found).toBeNull();
        expect(gh.mock.calls.every(([args]) => args[0] === 'auth')).toBe(true);
      });

      it('weighs remotes by name as gh does, and uses a lone remote under any name', async () => {
        const gh = listing();
        await lookUp(
          gh,
          [
            'remote.fork.url git@github.com:a/widgets.git',
            'remote.origin.url git@github.com:b/widgets.git',
            'remote.github.url git@github.com:c/widgets.git',
          ].join('\n')
        ).found;
        expect(repoOf(gh)).toBe('github.com/c/widgets');

        const lone = listing();
        await lookUp(lone, 'remote.fork.url git@github.com:me/widgets.git').found;
        expect(repoOf(lone)).toBe('github.com/me/widgets');
      });

      it('goes on to the next remote when the one gh was told to default to is on a host it cannot use', async () => {
        const gh = listing();
        await lookUp(
          gh,
          [
            'remote.mirror.url git@gitlab.com:team/widgets.git',
            'remote.mirror.gh-resolved base',
            'remote.origin.url git@github.com:me/widgets.git',
          ].join('\n')
        ).found;
        expect(repoOf(gh)).toBe('github.com/me/widgets');
      });

      it('finds no PR, without running gh, when the WSL remotes cannot be read or name no repository', async () => {
        for (const settings of [null, '', 'remote.origin.url not-a-remote']) {
          const gh = listing();
          expect(await lookUp(gh, settings).found).toBeNull();
          expect(gh).not.toHaveBeenCalled();
        }
      });

      it('runs gh in the folder of any other project', async () => {
        const gh = vi.fn().mockResolvedValue('[]');
        const remotes = vi.fn();

        await new PrGithub(gh, Date.now, remotes, 'win32').findOpenForBranch('C:\\repo', 'feat/x');
        expect(gh.mock.calls).toEqual([[LIST, { cwd: 'C:\\repo' }]]);
        expect(remotes).not.toHaveBeenCalled();
      });
    });

    it('names each pull request by its own variables in the query', () => {
      const query = batchQuery(2);
      expect(query).toContain('p1: repository(owner: $o1, name: $n1)');
      expect(query).toContain('isRequired(pullRequestNumber: $p1)');
      expect(query).toContain('@include(if: $t1)');
      expect(query.match(/viewer \{ login \}/g)).toHaveLength(1);
      expect(query).toContain('baseRefName baseRefOid');
    });
  });

  /**
   * A read-only `gh api graphql` answer for a real approved, clean PR on a merge-queue base,
   * trimmed to the fields the parser reads and renamed. Its rollup held 47 nodes; GitHub's own
   * page said "5 skipped, 30 successful" with nothing failing.
   */
  function recordedMergeQueuePr(): Record<string, unknown> {
    return JSON.parse(readFileSync(new URL('./__fixtures__/mergeQueuePr.json', import.meta.url), 'utf8'));
  }

  describe('latest run per check', () => {
    it("collapses the recorded PR's 47 rollup nodes to the 35 checks GitHub shows, none failing", async () => {
      const raw = recordedMergeQueuePr();
      const pr = (raw.data as { p0: { pullRequest: { commits: { nodes: { commit: unknown }[] } } } }).p0.pullRequest;
      const rollup = pr.commits.nodes[0].commit as { statusCheckRollup: { contexts: { nodes: unknown[] } } };
      expect(rollup.statusCheckRollup.contexts.nodes).toHaveLength(47);

      const [snapshot] = await new PrGithub(vi.fn().mockResolvedValue(JSON.stringify(raw))).snapshots([
        { ref: REF, threads: false },
      ]);
      if (snapshot instanceof GhError) throw snapshot;
      expect(snapshot.checks).toHaveLength(35);
      expect(countChecks(snapshot.checks)).toEqual({ pending: 0, pass: 30, fail: 0, skipped: 5 });
      expect(snapshot.checks.filter(check => check.name === 'preview gate')).toEqual([
        expect.objectContaining({ bucket: 'pass', required: true }),
      ]);
      expect(snapshot.mergeQueue).toEqual({ enabled: true });
      expect(snapshot.nodeId).toBe('PR_example611');
    });

    it('makes the recorded PR ready to queue, with a reviewer still requested', async () => {
      const raw = JSON.stringify(recordedMergeQueuePr());
      const [snapshot] = await new PrGithub(vi.fn().mockResolvedValue(raw)).snapshots([{ ref: REF, threads: false }]);
      if (snapshot instanceof GhError) throw snapshot;
      expect(snapshot.reviewDecision).toBe('APPROVED');
      expect(desktopMergeReadiness(snapshot)).toEqual({ ready: true, via: 'queue' });
    });

    const run = (id: number, conclusion: string, event = 'pull_request', workflow = 'CI') => ({
      __typename: 'CheckRun',
      databaseId: id,
      name: 'build',
      status: 'COMPLETED',
      conclusion,
      checkSuite: { app: { slug: 'github-actions' }, workflowRun: { event, workflow: { name: workflow } } },
    });

    it('keeps the newest of a re-run, wherever the rollup lists it', () => {
      expect(latestCheckRuns([run(9, 'SUCCESS'), run(3, 'FAILURE')])).toEqual([run(9, 'SUCCESS')]);
      expect(latestCheckRuns([run(3, 'FAILURE'), run(9, 'SUCCESS')])).toEqual([run(9, 'SUCCESS')]);
    });

    it('keeps one job run by two events, or by two workflows, as two checks, as GitHub does', () => {
      expect(latestCheckRuns([run(1, 'SUCCESS', 'push'), run(2, 'FAILURE', 'pull_request')])).toHaveLength(2);
      expect(latestCheckRuns([run(1, 'SUCCESS', 'push', 'CI'), run(2, 'SUCCESS', 'push', 'Nightly')])).toHaveLength(2);
    });

    it('leaves commit statuses alone', () => {
      const status = { __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS' };
      expect(latestCheckRuns([status, { ...status }])).toHaveLength(2);
    });
  });

  describe('merge queue', () => {
    it('reads the queue entry and the last removal', () => {
      const snapshot = parseSnapshot(
        REF,
        response({
          id: 'PR_1',
          isMergeQueueEnabled: true,
          mergeQueueEntry: { state: 'AWAITING_CHECKS', position: 2 },
          timelineItems: { nodes: [{ createdAt: '2026-10-09T12:00:00Z', reason: 'Required status check failed' }] },
        }),
        0,
        false
      );
      expect(snapshot.mergeQueue).toEqual({
        enabled: true,
        entry: { state: 'AWAITING_CHECKS', position: 2 },
        removed: { at: '2026-10-09T12:00:00Z', reason: 'Required status check failed' },
      });
    });

    it('asks for the removal only for a PR the app has queued, in the same query', async () => {
      const gh = vi.fn().mockResolvedValue(JSON.stringify(batched(repository(), repository({ number: 612 }))));
      await new PrGithub(gh).snapshots([
        { ref: REF, threads: false, queue: true },
        { ref: OTHER, threads: false },
      ]);
      expect(gh).toHaveBeenCalledTimes(1);
      expect(gh.mock.calls[0][0]).toEqual(expect.arrayContaining(['q0=true', 'q1=false']));
      expect(batchQuery(1)).toContain('REMOVED_FROM_MERGE_QUEUE_EVENT]) @include(if: $q0)');
    });

    it('enqueues by node id, pinned to the head it checked', async () => {
      const gh = vi
        .fn()
        .mockResolvedValue(JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { position: 3 } } } }));
      expect(await new PrGithub(gh).enqueue('PR_1', 'abc123')).toBe(3);
      const args = gh.mock.calls[0][0] as string[];
      expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
      expect(args).toEqual(expect.arrayContaining(['id=PR_1', 'sha=abc123']));
      expect(args.find(arg => arg.startsWith('query='))).toMatch(
        /enqueuePullRequest\(input: \{ pullRequestId: \$id, expectedHeadOid: \$sha \}\)/
      );
    });

    it("rejects with GitHub's words when the enqueue is refused", async () => {
      const gh = vi.fn().mockResolvedValue(JSON.stringify({ errors: [{ message: 'Head sha did not match' }] }));
      await expect(new PrGithub(gh).enqueue('PR_1', 'abc123')).rejects.toThrow('Head sha did not match');
    });
  });

  const OTHER: PrRef = { ...REF, number: 612, url: 'https://github.com/example-org/widgets/pull/612' };

  function repository(pullRequest: Record<string, unknown> = {}): Record<string, unknown> {
    const base = response().data.repository as Record<string, unknown>;
    return { ...base, pullRequest: { ...(base.pullRequest as Record<string, unknown>), ...pullRequest } };
  }

  function batched(...repositories: Record<string, unknown>[]) {
    return {
      data: { viewer: { login: 'octo-dev' }, ...Object.fromEntries(repositories.map((repo, i) => [`p${i}`, repo])) },
    };
  }

  describe('classifyGhFailure', () => {
    it('tells missing, signed-out and rate-limited apart', () => {
      expect(classifyGhFailure('', 'ENOENT')).toBe('missing');
      expect(classifyGhFailure('To get started with GitHub CLI, please run:  gh auth login', 4)).toBe(
        'unauthenticated'
      );
      expect(classifyGhFailure('gh: API rate limit exceeded for user ID 1. (HTTP 403)', 1)).toBe('rate-limited');
      expect(classifyGhFailure('GraphQL: Could not resolve to a PullRequest with the number of 9.', 1)).toBe(
        'not-found'
      );
      expect(classifyGhFailure('something else broke', 1)).toBe('failed');
    });
  });
});

describe.skipIf(process.platform === 'win32')('runGh', () => {
  let directory: string;

  beforeEach(async () => {
    vi.resetModules();
    directory = await mkdtemp(join(tmpdir(), 'b4m-gh-'));
  });

  afterEach(async () => {
    vi.doUnmock('../chat/tools/userPath');
    await rm(directory, { recursive: true, force: true });
  });

  const usePath = async (path: string): Promise<typeof import('./gh')> => {
    const actual = await vi.importActual<typeof import('../chat/tools/userPath')>('../chat/tools/userPath');
    vi.doMock('../chat/tools/userPath', () => ({ ...actual, resolveUserPath: async () => path }));
    return import('./gh');
  };

  it('runs the gh from an absolute PATH folder, never one in the project folder', async () => {
    const project = join(directory, 'project');
    const bin = join(directory, 'bin');
    await mkdir(project);
    await mkdir(bin);
    await writeFile(join(project, 'gh'), '#!/bin/sh\nprintf project\n', { mode: 0o755 });
    await writeFile(join(bin, 'gh'), '#!/bin/sh\nprintf installed\n', { mode: 0o755 });
    const { runGh } = await usePath(`.:${bin}`);

    expect(await runGh(['pr', 'list'], { cwd: project })).toBe('installed');
  });

  it('reports gh as missing when no absolute PATH folder has it', async () => {
    const project = join(directory, 'project');
    await mkdir(project);
    await writeFile(join(project, 'gh'), '#!/bin/sh\nprintf project\n', { mode: 0o755 });
    const { runGh, GhError } = await usePath('.');

    const failure = await runGh(['pr', 'list'], { cwd: project }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GhError);
    expect(failure).toMatchObject({ kind: 'missing', message: 'gh is not installed' });
  });
});
