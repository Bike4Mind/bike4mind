import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateBusyReport, UpdateState } from '@shared/update';
import { UpdateService, type UpdaterPort } from './UpdateService';

const QUIET: UpdateBusyReport = { replying: 0, awaitingApproval: 0, background: 0 };

function harness(options: { updater?: UpdaterPort | null; busy?: UpdateBusyReport } = {}) {
  const port: UpdaterPort = options.updater ?? {
    check: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    install: vi.fn(),
  };
  const busy = vi.fn(() => options.busy ?? QUIET);
  const prepareQuit = vi.fn(async () => undefined);
  const pushed: UpdateState[] = [];

  const service = new UpdateService({
    currentVersion: '1.0.0',
    updater: options.updater === null ? null : port,
    busy,
    prepareQuit,
    onChanged: state => pushed.push(state),
  });

  return { service, port, busy, prepareQuit, pushed };
}

/** Walk a service to 'ready', the way the updater's events would. */
function stage(service: UpdateService): void {
  service.apply({ type: 'available', version: '1.1.0', at: 1 });
  service.apply({ type: 'downloaded', version: '1.1.0' });
}

describe('UpdateService without a feed', () => {
  it('stays unsupported and touches nothing', async () => {
    const { service, pushed } = harness({ updater: null });
    expect(service.snapshot().status).toBe('unsupported');

    await service.check();
    await service.download();
    expect(service.snapshot().status).toBe('unsupported');
    expect(pushed).toHaveLength(0);
  });

  it('refuses to install, since there is nothing to install', async () => {
    const { service } = harness({ updater: null });
    await expect(service.install(true)).resolves.toEqual({ ok: false, reason: 'not-ready' });
  });
});

describe('UpdateService.check', () => {
  it('reports the check started and asks the updater once', async () => {
    const { service, port, pushed } = harness();
    await service.check();
    expect(port.check).toHaveBeenCalledTimes(1);
    expect(pushed.map(state => state.status)).toEqual(['checking']);
  });

  it('turns a thrown check into a quiet unreachable, never a rejection', async () => {
    const { service } = harness({
      updater: {
        check: vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
        download: vi.fn(async () => undefined),
        install: vi.fn(),
      },
    });

    await expect(service.check()).resolves.toBeUndefined();
    expect(service.snapshot().status).toBe('unreachable');
  });

  it('does not re-check over a staged update', async () => {
    const { service, port } = harness();
    stage(service);
    await service.check();
    expect(port.check).not.toHaveBeenCalled();
    expect(service.snapshot().status).toBe('ready');
  });
});

describe('UpdateService.download', () => {
  it('only runs for an update that is actually on offer', async () => {
    const { service, port } = harness();
    await service.download();
    expect(port.download).not.toHaveBeenCalled();

    service.apply({ type: 'available', version: '1.1.0', at: 1 });
    await service.download();
    expect(port.download).toHaveBeenCalledTimes(1);
    expect(service.snapshot().status).toBe('downloading');
  });

  it('falls back to the offer when the download throws, so it can be retried', async () => {
    const { service } = harness({
      updater: {
        check: vi.fn(async () => undefined),
        download: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
        install: vi.fn(),
      },
    });
    service.apply({ type: 'available', version: '1.1.0', at: 1 });
    await expect(service.download()).resolves.toBeUndefined();
    expect(service.snapshot()).toMatchObject({ status: 'available', version: '1.1.0', percent: 0 });
  });
});

describe('UpdateService.install', () => {
  let clock: ReturnType<typeof harness>;

  beforeEach(() => {
    clock = harness();
  });

  it('refuses before an update is staged', async () => {
    await expect(clock.service.install(false)).resolves.toEqual({ ok: false, reason: 'not-ready' });
    expect(clock.port.install).not.toHaveBeenCalled();
  });

  it('installs when nothing is running, killing children first', async () => {
    stage(clock.service);
    await expect(clock.service.install(false)).resolves.toEqual({ ok: true });
    expect(clock.prepareQuit).toHaveBeenCalledTimes(1);
    expect(clock.port.install).toHaveBeenCalledTimes(1);
  });

  it('reports what is in flight and does NOT quit', async () => {
    const busy = { replying: 1, awaitingApproval: 0, background: 2 };
    const { service, port, prepareQuit } = harness({ busy });
    stage(service);

    await expect(service.install(false)).resolves.toEqual({ ok: false, reason: 'busy', busy });
    expect(port.install).not.toHaveBeenCalled();
    expect(prepareQuit).not.toHaveBeenCalled();
    expect(service.snapshot().status).toBe('ready');
  });

  it('goes ahead once the user has forced it', async () => {
    const { service, port, prepareQuit } = harness({ busy: { replying: 1, awaitingApproval: 0, background: 0 } });
    stage(service);

    await expect(service.install(true)).resolves.toEqual({ ok: true });
    expect(prepareQuit).toHaveBeenCalledTimes(1);
    expect(port.install).toHaveBeenCalledTimes(1);
  });

  it('still hands over when the graceful teardown fails', async () => {
    const { service, port } = harness();
    stage(service);
    const failing = new UpdateService({
      currentVersion: '1.0.0',
      updater: { check: vi.fn(async () => undefined), download: vi.fn(async () => undefined), install: port.install },
      busy: () => QUIET,
      prepareQuit: async () => {
        throw new Error('a child would not die');
      },
      onChanged: () => undefined,
    });
    failing.apply({ type: 'available', version: '1.1.0', at: 1 });
    failing.apply({ type: 'downloaded', version: '1.1.0' });

    await expect(failing.install(true)).resolves.toEqual({ ok: true });
    expect(port.install).toHaveBeenCalledTimes(1);
  });
});

describe('UpdateService notice support', () => {
  function noticeHarness(memory: { stored?: string | null; failWrite?: boolean } = {}) {
    let stored = memory.stored ?? null;
    const dismissed = {
      read: vi.fn(async () => stored),
      record: vi.fn(async (version: string) => {
        if (memory.failWrite) throw new Error('EACCES');
        stored = version;
      }),
    };
    const log = vi.fn();
    const pushed: UpdateState[] = [];
    const service = new UpdateService({
      currentVersion: '1.0.0',
      updater: {
        check: vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
        download: vi.fn(async () => undefined),
        install: vi.fn(),
      },
      busy: () => QUIET,
      prepareQuit: async () => undefined,
      onChanged: state => pushed.push(state),
      releaseUrl: version => `https://example.test/releases/${version}`,
      dismissed,
      log,
    });
    return { service, dismissed, log, pushed, stored: () => stored };
  }

  it('attaches the release page for the offered version', () => {
    const { service } = noticeHarness();
    expect(service.snapshot().releaseUrl).toBeNull();
    service.apply({ type: 'available', version: '1.1.0', at: 1 });
    expect(service.snapshot().releaseUrl).toBe('https://example.test/releases/1.1.0');
  });

  it('persists a dismissal and pushes it to the renderer', async () => {
    const { service, pushed, stored } = noticeHarness();
    await service.dismiss('1.1.0');
    expect(stored()).toBe('1.1.0');
    expect(service.snapshot().dismissedVersion).toBe('1.1.0');
    expect(pushed.at(-1)?.dismissedVersion).toBe('1.1.0');
  });

  it('restores the dismissal from a previous launch', async () => {
    const { service, pushed } = noticeHarness({ stored: '1.1.0' });
    await service.restoreDismissed();
    expect(service.snapshot().dismissedVersion).toBe('1.1.0');
    expect(pushed).toHaveLength(1);
  });

  it('still hides the notice for this run when the file cannot be written, and logs it', async () => {
    const { service, log } = noticeHarness({ failWrite: true });
    await expect(service.dismiss('1.1.0')).resolves.toBeUndefined();
    expect(service.snapshot().dismissedVersion).toBe('1.1.0');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  it('logs a failed check instead of surfacing it', async () => {
    const { service, log } = noticeHarness();
    await service.check();
    expect(service.snapshot().status).toBe('unreachable');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
  });
});
