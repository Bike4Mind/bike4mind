import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import type { ChatSessionSummary } from '@shared/chat';
import { HostRuntime, hostProtectedLocations, type HostEnvironment, type HostEventSink } from '.';

// A headless host has no Electron to load, so any import of it from src/host fails here.
vi.mock('electron', () => {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`src/host reached Electron (read "${String(property)}")`);
      },
    }
  );
});

const signedOut: AuthState = {
  status: 'signed-out',
  environment: { preset: 'hosted', url: 'http://localhost:3000', label: 'Test' },
  hostedAvailable: true,
  storage: 'available',
  busy: 'idle',
};

const roots: string[] = [];
const runtimes: HostRuntime[] = [];

afterEach(async () => {
  runtimes.splice(0).forEach(runtime => runtime.service.dispose());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function recordingSink() {
  const summaries: ChatSessionSummary[] = [];
  const events: HostEventSink = {
    streamEvent: vi.fn(),
    sessionSummary: summary => summaries.push(summary),
    sessionStatus: vi.fn(),
    queueChanged: vi.fn(),
    taskDecisions: vi.fn(),
    loopChanged: vi.fn(),
  };
  return { events, summaries };
}

async function headlessRuntime(pullRequests?: { forget: (sessionId: string) => Promise<void> }) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'b4m-host-runtime-'));
  roots.push(dataDirectory);
  const environment: HostEnvironment = {
    dataDirectory,
    homeDirectory: join(dataDirectory, 'home'),
    appName: 'Bike4Mind Test',
    platform: process.platform,
  };
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const { events, summaries } = recordingSink();
  const runtime = new HostRuntime({
    environment,
    events,
    auth: { getApiClient: () => null, getState: () => signedOut },
    logger,
    protection: hostProtectedLocations(environment, logger),
    collaborators: pullRequests
      ? {
          pullRequests: () => ({
            bindForAgent: vi.fn(),
            dismiss: vi.fn(),
            forget: pullRequests.forget,
          }),
        }
      : {},
  });
  runtimes.push(runtime);
  return { runtime, dataDirectory, summaries };
}

describe('HostRuntime without Electron', () => {
  it('lists no sessions on a fresh data directory', async () => {
    const { runtime } = await headlessRuntime();

    await expect(runtime.listSessions()).resolves.toEqual([]);
  });

  it('writes a created session under <dataDirectory>/sessions and pushes its summary on rename', async () => {
    const { runtime, dataDirectory, summaries } = await headlessRuntime();

    const created = await runtime.createSession();
    const files = await readdir(join(dataDirectory, 'sessions'), { recursive: true });
    expect(files.some(file => file.includes(created.id))).toBe(true);

    await runtime.renameSession(created.id, 'Renamed');
    expect(summaries).toEqual([expect.objectContaining({ id: created.id, title: 'Renamed' })]);
    await expect(runtime.listSessions()).resolves.toEqual([expect.objectContaining({ id: created.id })]);
  });

  it('asks through the given confirm before archiving a parent, and archives nothing on cancel', async () => {
    const { runtime } = await headlessRuntime();
    const parent = await runtime.createSession();
    await runtime.store.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'child task' },
    });
    const confirm = vi.fn(async () => ({ response: 1, checkboxChecked: false }));

    await expect(runtime.setSessionArchived(parent.id, true, confirm)).resolves.toBeNull();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Archive', 'Cancel'] }));
    expect((await runtime.getSession(parent.id, false))?.archived).toBeFalsy();

    confirm.mockResolvedValue({ response: 0, checkboxChecked: false });
    await expect(runtime.setSessionArchived(parent.id, true, confirm)).resolves.toMatchObject({
      id: parent.id,
      archived: true,
    });
  });

  it('archives a session with no sub-sessions without asking', async () => {
    const { runtime } = await headlessRuntime();
    const session = await runtime.createSession();
    const confirm = vi.fn(async () => ({ response: 0, checkboxChecked: false }));

    await expect(runtime.setSessionArchived(session.id, true, confirm)).resolves.toMatchObject({ archived: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('forgets the pull request of a deleted session, after the session is gone', async () => {
    const forget = vi.fn(async (_sessionId: string): Promise<void> => undefined);
    const { runtime } = await headlessRuntime({ forget });
    const session = await runtime.createSession();
    forget.mockImplementation(async () => {
      expect(await runtime.getSession(session.id, false)).toBeNull();
    });

    await runtime.deleteSession(session.id, false);

    expect(forget).toHaveBeenCalledWith(session.id);
  });

  it('deletes a session when no pull request monitor is wired', async () => {
    const { runtime } = await headlessRuntime();
    const session = await runtime.createSession();

    await runtime.deleteSession(session.id, false);

    await expect(runtime.listSessions()).resolves.toEqual([]);
  });
});
