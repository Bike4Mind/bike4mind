import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Signals the process and everything it started: its process group on POSIX, its tree on Windows. */
export function signalTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL', sync = false): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T', '/F'];
    if (sync) spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    else spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill(signal));
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

// An 'exit' listener may only do synchronous work.
function killLiveChildren(): void {
  for (const child of liveChildren) signalTree(child, 'SIGKILL', true);
}

/**
 * Kills `child`'s tree when this process exits normally, and its process group once it exits itself. The child must
 * lead its own group on POSIX (`detached: true`).
 */
export function trackChild(child: ChildProcess): void {
  if (!exitHookInstalled) {
    process.on('exit', killLiveChildren);
    exitHookInstalled = true;
  }
  liveChildren.add(child);
  child.once('exit', () => {
    liveChildren.delete(child);
    // A launcher that exits first would leave the server running where stop() cannot reach it.
    if (process.platform !== 'win32' && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // ESRCH: the group is already gone.
      }
    }
  });
  // A child that never spawned emits 'error' and no 'exit'.
  child.once('error', () => {
    if (child.pid === undefined) liveChildren.delete(child);
  });
}

/** For tests: how many children the parent-exit hook still holds. */
export function trackedChildCount(): number {
  return liveChildren.size;
}

/** Bounds shutdown even when the OS cannot reap a process after SIGKILL. */
export async function stopTree<Exit>(child: ChildProcess, exited: Promise<Exit>, timeoutMs: number): Promise<Exit> {
  signalTree(child, 'SIGTERM');
  const killTimer = setTimeout(() => signalTree(child, 'SIGKILL'), timeoutMs);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error(`Process ${child.pid} did not exit after SIGKILL.`)),
      timeoutMs * 2
    );
  });
  try {
    return await Promise.race([exited, deadline]);
  } finally {
    clearTimeout(killTimer);
    clearTimeout(deadlineTimer);
  }
}
