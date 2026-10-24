import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatToolApproval } from '@shared/chat';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalLog, summarizeToolInput, type ApprovalLogEntry } from './ApprovalLog';

const renameFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: (...args: Parameters<typeof actual.rename>) =>
      renameFailure.code
        ? Promise.reject(Object.assign(new Error(renameFailure.code), { code: renameFailure.code }))
        : actual.rename(...args),
  };
});

const approval: ChatToolApproval = {
  outcome: 'allowed',
  decidedBy: { kind: 'mode', mode: 'auto' },
  asked: false,
  decidedAt: '2026-10-22T00:00:00.000Z',
};

function entry(overrides: Partial<ApprovalLogEntry> = {}): ApprovalLogEntry {
  return {
    ts: approval.decidedAt,
    sessionId: 'session-a',
    sessionTitle: 'A chat',
    mode: 'auto',
    tool: 'bash_execute',
    input: 'git status',
    approval,
    ...overrides,
  };
}

async function lines(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as unknown);
}

describe('ApprovalLog', () => {
  it('appends one JSON line per decision, readable only by the user', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'b4m-approval-log-')), 'approval-log.jsonl');
    const log = new ApprovalLog(path, vi.fn());

    await log.append(entry());
    await log.append(entry({ sessionId: 'session-b', input: 'ls' }));

    const written = await lines(path);
    expect(written).toEqual([entry(), entry({ sessionId: 'session-b', input: 'ls' })]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rotates to one previous file once the size cap would be passed', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'b4m-approval-log-')), 'approval-log.jsonl');
    const lineBytes = Buffer.byteLength(`${JSON.stringify(entry())}\n`);
    const log = new ApprovalLog(path, vi.fn(), lineBytes * 2);

    await Promise.all([log.append(entry({ input: 'one' })), log.append(entry({ input: 'two' }))]);
    await log.append(entry({ input: 'thr' }));
    await log.append(entry({ input: 'fou' }));
    await log.append(entry({ input: 'fiv' }));

    expect(log.rotatedPath).toBe(path.replace(/\.jsonl$/, '.1.jsonl'));
    expect((await lines(path)).map(line => (line as ApprovalLogEntry).input)).toEqual(['fiv']);
    expect((await lines(log.rotatedPath)).map(line => (line as ApprovalLogEntry).input)).toEqual(['thr', 'fou']);
  });

  it('keeps appending when the rotation is blocked, and warns on any other rename failure', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'b4m-approval-log-')), 'approval-log.jsonl');
    const lineBytes = Buffer.byteLength(`${JSON.stringify(entry())}\n`);
    const warn = vi.fn();
    const log = new ApprovalLog(path, warn, lineBytes);

    try {
      renameFailure.code = 'EBUSY';
      await log.append(entry({ input: 'one' }));
      await log.append(entry({ input: 'two' }));
      expect((await lines(path)).map(line => (line as ApprovalLogEntry).input)).toEqual(['one', 'two']);
      expect(warn).not.toHaveBeenCalled();

      renameFailure.code = 'EIO';
      await log.append(entry({ input: 'thr' }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not write the approval log'));
    } finally {
      renameFailure.code = undefined;
    }
  });

  it('warns instead of throwing when the file cannot be written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-approval-log-'));
    // A directory where the file should be: every append fails.
    const path = join(directory, 'approval-log.jsonl');
    await mkdir(path);
    const warn = vi.fn();
    const log = new ApprovalLog(path, warn);

    await expect(log.append(entry())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not write the approval log'));

    // A failed write does not wedge the chain for the next one.
    await expect(log.append(entry())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('summarizeToolInput', () => {
  it('names the command or path rather than dumping the arguments', () => {
    expect(summarizeToolInput({ command: 'git status', cwd: '/x' })).toBe('git status');
    expect(summarizeToolInput({ path: '/x/notes.txt', content: 'secret body' })).toBe('/x/notes.txt');
    expect(summarizeToolInput({ query: 'q' })).toBe('{"query":"q"}');
  });

  it('masks a bearer token, since the log outlives the conversation', () => {
    const summary = summarizeToolInput({ command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefgh" https://x' });
    expect(summary).not.toContain('sk-ant-api03-abcdefgh');
    expect(summary).toContain('[redacted]');
  });

  it('caps a long input', () => {
    const summary = summarizeToolInput({ command: 'ab '.repeat(700) });
    expect(summary).toHaveLength(503);
    expect(summary.endsWith('...')).toBe(true);
  });
});
