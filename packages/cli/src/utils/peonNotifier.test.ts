import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// peonNotifier caches the resolved script path at module scope, so each test
// re-imports the module fresh (vi.resetModules) after configuring the mocks.

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('child_process', () => ({ spawn: vi.fn() }));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => '/home/tester' };
});

vi.mock('../store', () => ({
  useCliStore: { getState: () => ({ session: { id: 'sess-123' } }) },
}));

vi.mock('./Logger', () => ({ logger: { debug: vi.fn() } }));

import { existsSync } from 'fs';
import { spawn } from 'child_process';

const mockedExists = vi.mocked(existsSync);
const mockedSpawn = vi.mocked(spawn);

function makeChild() {
  const stdin = { on: vi.fn(), end: vi.fn() };
  return { on: vi.fn(), stdin, unref: vi.fn() } as unknown as ReturnType<typeof spawn>;
}

async function freshModule() {
  vi.resetModules();
  return import('./peonNotifier');
}

const INSTALLED_PATH = '/home/tester/.claude/hooks/peon-ping/peon.sh';

describe('peonNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.B4M_PEON_PING;
    delete process.env.CLAUDE_PEON_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    mockedSpawn.mockImplementation(() => makeChild());
  });

  afterEach(() => {
    delete process.env.B4M_PEON_PING;
  });

  describe('isPeonAvailable', () => {
    it('returns true when peon.sh exists in the default Claude hooks dir', async () => {
      mockedExists.mockImplementation(p => p === INSTALLED_PATH);
      const { isPeonAvailable } = await freshModule();
      expect(isPeonAvailable()).toBe(true);
    });

    it('returns false when peon.sh is not found anywhere', async () => {
      mockedExists.mockReturnValue(false);
      const { isPeonAvailable } = await freshModule();
      expect(isPeonAvailable()).toBe(false);
    });

    it('returns false when disabled via B4M_PEON_PING even if installed', async () => {
      mockedExists.mockReturnValue(true);
      process.env.B4M_PEON_PING = '0';
      const { isPeonAvailable } = await freshModule();
      expect(isPeonAvailable()).toBe(false);
    });
  });

  describe('notifyPeon', () => {
    it('spawns peon.sh with a well-formed JSON payload on stdin', async () => {
      mockedExists.mockImplementation(p => p === INSTALLED_PATH);
      const child = makeChild();
      mockedSpawn.mockReturnValue(child);

      const { notifyPeon } = await freshModule();
      notifyPeon('Notification', { notificationType: 'permission_prompt' });

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockedSpawn.mock.calls[0];
      expect(cmd).toBe('bash');
      expect(args).toEqual([INSTALLED_PATH]);

      const payload = JSON.parse(vi.mocked(child.stdin!.end).mock.calls[0][0] as string);
      expect(payload).toMatchObject({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        session_id: 'sess-123',
      });
      expect(child.unref).toHaveBeenCalled();
    });

    it('is a no-op when peon-ping is not installed', async () => {
      mockedExists.mockReturnValue(false);
      const { notifyPeon } = await freshModule();
      notifyPeon('Stop');
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it('does not throw if spawn fails', async () => {
      mockedExists.mockImplementation(p => p === INSTALLED_PATH);
      mockedSpawn.mockImplementation(() => {
        throw new Error('spawn ENOENT');
      });
      const { notifyPeon } = await freshModule();
      expect(() => notifyPeon('Stop')).not.toThrow();
    });
  });

  describe('startPeonNotifier', () => {
    it('returns a no-op unsubscribe when peon-ping is unavailable', async () => {
      mockedExists.mockReturnValue(false);
      const { startPeonNotifier } = await freshModule();
      const unsubscribe = startPeonNotifier();
      expect(typeof unsubscribe).toBe('function');
      expect(mockedSpawn).not.toHaveBeenCalled();
    });
  });
});
