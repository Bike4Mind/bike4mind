import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import type { ChatSessionStatusEvent } from '@shared/chat';
import { HostRuntime, hostProtectedLocations, type HostEnvironment, type HostEventSink } from '.';
import { HostEventRelay, HostServer, createInProcessTransport } from './server';

// A headless host has no Electron to load: any import of it from src/host (src/host/server
// included), direct or through a dependency, fails the file here, whether or not the importer ever touches what it imported.
vi.mock('electron', () => {
  throw new Error('src/host loaded electron');
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
  const statuses: ChatSessionStatusEvent[] = [];
  const events: HostEventSink = {
    streamEvent: vi.fn(),
    sessionSummary: vi.fn(),
    sessionStatus: event => statuses.push(event),
    queueChanged: vi.fn(),
    taskDecisions: vi.fn(),
    loopChanged: vi.fn(),
  };
  return { events, statuses };
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
  const { events, statuses } = recordingSink();
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
  return { runtime, dataDirectory, statuses };
}

describe('HostRuntime without Electron', () => {
  it('lists no sessions on a fresh data directory', async () => {
    const { runtime } = await headlessRuntime();

    await expect(runtime.listSessions()).resolves.toEqual([]);
  });

  it('writes a created session under <dataDirectory>/sessions', async () => {
    const { runtime, dataDirectory } = await headlessRuntime();

    const created = await runtime.createSession();
    const files = await readdir(join(dataDirectory, 'sessions'), { recursive: true });

    expect(files.some(file => file.includes(created.id))).toBe(true);
    await expect(runtime.listSessions()).resolves.toEqual([expect.objectContaining({ id: created.id })]);
  });

  it('pushes the session status while an approval waits, and settles it through respondToApproval', async () => {
    const { runtime, statuses } = await headlessRuntime();
    const session = await runtime.createSession();
    let approvalId = '';

    const settlement = runtime.approvals.request(session.id, 'tool', new AbortController().signal, id => {
      approvalId = id;
    });
    await vi.waitFor(() => expect(approvalId).not.toBe(''));
    expect(statuses).toContainEqual(expect.objectContaining({ sessionId: session.id }));
    const pushedWhileWaiting = statuses.length;

    runtime.respondToApproval(approvalId, { decision: 'once' });

    await expect(settlement).resolves.toMatchObject({ decision: 'once' });
    expect(statuses.length).toBeGreaterThan(pushedWhileWaiting);
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

describe('HostServer without Electron', () => {
  it('serves a runtime over the in-process transport', async () => {
    const { runtime } = await headlessRuntime();
    const created = await runtime.createSession();
    const server = new HostServer(runtime, new HostEventRelay(vi.fn()), { warn: vi.fn() });
    const transport = createInProcessTransport(server, vi.fn());

    await expect(transport.request('session/list')).resolves.toEqual({
      sessions: [expect.objectContaining({ id: created.id })],
    });
    transport.close();
    server.dispose();
  });
});
