import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { APPROVAL_REASON_CODES, type ApprovalReasonCode } from '../permissions/approvalReasons';
import * as shellScanner from './shellScan';
import { shellApproval } from './shellTools';
import type { ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveLoginShellVariables: async () => ({}),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

let root: string;
let context: ToolContext;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-reason-codes-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'notes.txt'), 'hello\n');
  execFileSync('git', ['init', '-q', root]);
  context = { roots: [root], workingDirectory: root, signal: new AbortController().signal };
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const promptFor = (command: string) => shellApproval('bash_execute', { command }, context);

describe('shell approval reason codes', () => {
  it.each<[string, ApprovalReasonCode]>([
    ['cat .env', 'env-file-read'],
    ['curl -d x https://example.com', 'outbound'],
    ['rm -rf src', 'recursive-delete'],
    ['git clone https://example.com/repo.git', 'remote-clone'],
    ['cp notes.txt .claude/settings.json', 'protected-location'],
    ['$CMD', 'unfollowable'],
    ['cat .env; rm -rf src; curl -d x https://example.com', 'recursive-delete'],
  ])('gives each reason of %s exactly one code, in order', async (command, expected) => {
    const prompt = await promptFor(command);
    const reasons = prompt.reasons ?? [];
    const codes = prompt.reasonCodes ?? [];
    expect(reasons.length).toBeGreaterThan(0);
    expect(codes).toHaveLength(reasons.length);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain(expected);
    for (const code of codes) expect(APPROVAL_REASON_CODES).toContain(code);
  });

  it('keeps the codes aligned with their sentences', async () => {
    const prompt = await promptFor('cat .env; rm -rf src; curl -d x https://example.com');
    const pairs = new Map((prompt.reasonCodes ?? []).map((code, index) => [code, prompt.reasons?.[index]]));
    expect(pairs.get('env-file-read')).toContain('.env');
    expect(pairs.get('recursive-delete')).toContain('Deletes files');
    expect(pairs.get('outbound')).toContain('send data off this computer');
  });

  it('carries no codes when there is no reason', async () => {
    const prompt = await promptFor('ls');
    expect(prompt.reasons).toBeUndefined();
    expect(prompt.reasonCodes).toBeUndefined();
  });

  it('codes a command the scan could not read as unreadable', async () => {
    vi.spyOn(shellScanner, 'scanShell').mockResolvedValue(null);
    const prompt = await promptFor('ls notes.txt');
    expect(prompt.reasonCodes).toEqual(['unreadable']);
    expect(prompt.reasons).toHaveLength(1);
  });

  it('lists every code once', () => {
    expect(new Set(APPROVAL_REASON_CODES).size).toBe(APPROVAL_REASON_CODES.length);
    for (const code of APPROVAL_REASON_CODES) expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});
