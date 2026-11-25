import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@shared/auth';
import type { ChatSessionStatusEvent } from '@shared/chat';
import { hostErrorData, hostMethods, type HostResult } from '@shared/hostProtocol';
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

const execFileAsync = promisify(execFile);

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

  it('archives a parent with sub-sessions only once the decision is confirmed', async () => {
    const { runtime } = await headlessRuntime();
    const parent = await runtime.createSession();
    const child = await runtime.store.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'child task' },
    });

    const asked = await runtime.setSessionArchived(parent.id, true);
    expect(asked).toEqual({
      summary: null,
      confirmationRequired: {
        parentTitle: parent.title,
        finished: [{ id: child.id, title: child.title }],
        kept: [],
      },
    });
    expect((await runtime.getSession(parent.id, false))?.archived).toBeFalsy();

    await expect(
      runtime.setSessionArchived(parent.id, true, { confirmed: true, archiveChildIds: [child.id] })
    ).resolves.toMatchObject({ summary: { id: parent.id, archived: true } });
    expect((await runtime.getSession(child.id, false))?.archived).toBe(true);
  });

  it('archives a session with no sub-sessions without asking', async () => {
    const { runtime } = await headlessRuntime();
    const session = await runtime.createSession();

    await expect(runtime.setSessionArchived(session.id, true)).resolves.toMatchObject({
      summary: { archived: true },
    });
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

describe('HostRuntime projects without Electron', () => {
  it('creates a Code session in a repository and remembers its folder in the data directory', async () => {
    const { runtime, dataDirectory } = await headlessRuntime();
    const repository = await gitRepository(dataDirectory, 'app');

    const result = await runtime.createCodeSession({ directory: repository });

    expect(result).toMatchObject({ ok: true, session: { project: { directory: repository } } });
    await expect(runtime.listRecentFolders()).resolves.toEqual([{ path: repository, name: 'app' }]);
    const saved = JSON.parse(await readFile(join(dataDirectory, 'recent-folders.json'), 'utf8')) as unknown;
    expect(saved).toEqual({ folders: [repository] });
  });

  it('inspects a repository and a plain folder', async () => {
    const { runtime, dataDirectory } = await headlessRuntime();
    const repository = await gitRepository(dataDirectory, 'app');
    const plain = join(dataDirectory, 'plain');
    await mkdir(plain);

    await expect(runtime.inspectProject(repository)).resolves.toMatchObject({
      directory: repository,
      isRepository: true,
      branches: ['main'],
      currentBranch: 'main',
    });
    await expect(runtime.inspectProject(plain)).resolves.toMatchObject({
      directory: plain,
      isRepository: false,
      branches: [],
    });
  });

  it('allows repository operations only on a remembered folder, until it is forgotten', async () => {
    const { runtime, dataDirectory } = await headlessRuntime();
    const repository = await gitRepository(dataDirectory, 'app');
    const stranger = await gitRepository(dataDirectory, 'stranger');

    await runtime.rememberRecentFolder(repository);
    await expect(runtime.isKnownRepository(repository)).resolves.toBe(true);
    await expect(runtime.isKnownRepository(stranger)).resolves.toBe(false);

    await expect(runtime.forgetRecentFolder(repository)).resolves.toEqual([]);
    await expect(runtime.isKnownRepository(repository)).resolves.toBe(false);
  });

  it('browses the home directory by default', async () => {
    const { runtime, dataDirectory } = await headlessRuntime();
    const home = join(dataDirectory, 'home');
    await mkdir(join(home, 'code'), { recursive: true });

    const result = await runtime.browseDirectory();

    expect(result).toMatchObject({ ok: true, listing: { path: await realpath(home) } });
    expect(result.ok && result.listing.entries.map(entry => entry.name)).toEqual(['code']);
    await expect(runtime.browseDirectory('~/missing')).resolves.toMatchObject({ ok: false, reason: 'notFound' });
  });
});

describe('HostRuntime background processes without Electron', () => {
  it('stops a running process and reports one it does not know', async () => {
    const { runtime, dataDirectory } = await headlessRuntime();
    const session = await runtime.createSession();
    const started = await runtime.background.start({
      sessionId: session.id,
      command: 'sleep 30',
      cwd: dataDirectory,
      roots: [dataDirectory],
      protectedPaths: [],
    });

    await expect(runtime.stopBackgroundProcess(session.id, started.id)).resolves.toMatchObject({
      ok: true,
      process: { id: started.id, status: 'killed' },
    });
    await expect(runtime.stopBackgroundProcess('another-session', started.id)).resolves.toEqual({
      ok: false,
      reason: 'notFound',
    });
    await expect(runtime.stopBackgroundProcess(session.id, 'no-such-process')).resolves.toEqual({
      ok: false,
      reason: 'notFound',
    });
  });
});

describe('HostRuntime results on the host protocol', () => {
  it('fit the protocol result of each method they back, with no reshaping beyond unwrapping', async () => {
    const { runtime, dataDirectory } = await headlessRuntime();
    const repository = await gitRepository(dataDirectory, 'app');
    await mkdir(join(dataDirectory, 'home'));
    const parent = await runtime.createSession();
    await runtime.store.create(undefined, { origin: { parentSessionId: parent.id, depth: 1, seedPrompt: 'task' } });

    const created: HostResult<'session/create'> = await runtime.createCodeSession({ directory: repository });
    const archived: HostResult<'session/setArchived'> = await runtime.setSessionArchived(parent.id, true);
    const inspection = await runtime.inspectProject(repository);
    const inspected: HostResult<'project/inspect'> = { inspection };
    const recent: HostResult<'project/recent'> = { folders: await runtime.listRecentFolders() };
    const forgotten: HostResult<'project/forgetRecent'> = { folders: await runtime.forgetRecentFolder(repository) };
    const browsed = await runtime.browseDirectory();
    const missing = await runtime.browseDirectory('~/gone');
    const stopped = await runtime.stopBackgroundProcess(parent.id, 'no-such-process');

    expect(hostMethods['session/create'].result.safeParse(created).success).toBe(true);
    expect(hostMethods['session/setArchived'].result.safeParse(archived).success).toBe(true);
    expect(archived.confirmationRequired).toBeDefined();
    expect(hostMethods['project/inspect'].result.safeParse(inspected).success).toBe(true);
    expect(hostMethods['project/recent'].result.safeParse(recent).success).toBe(true);
    expect(hostMethods['project/forgetRecent'].result.safeParse(forgotten).success).toBe(true);
    if (!browsed.ok || missing.ok || stopped.ok) throw new Error('unexpected outcome');
    const listing: HostResult<'fs/browse'> = browsed.listing;
    expect(hostMethods['fs/browse'].result.safeParse(listing).success).toBe(true);
    expect(hostErrorData.pathUnavailable.safeParse({ path: missing.path, reason: missing.reason }).success).toBe(true);
  });
});

async function gitRepository(parent: string, name: string): Promise<string> {
  const directory = join(await realpath(parent), name);
  await mkdir(directory, { recursive: true });
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: directory });
  await git('init', '--initial-branch=main');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init');
  return directory;
}
