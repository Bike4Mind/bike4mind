import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatToolApproval } from '@shared/chat';
import type { ApprovalLogEntry } from './ApprovalLog';
import { entryPatterns, formatApprovalSummary, readApprovalLog, summarizeApprovals } from './approvalSummary';

const entry = (
  overrides: Partial<Omit<ApprovalLogEntry, 'approval'>> & { approval?: Partial<ChatToolApproval> } = {}
): ApprovalLogEntry => ({
  ts: '2026-10-24T03:00:00.000Z',
  sessionId: 's1',
  mode: 'auto',
  tool: 'bash_execute',
  input: 'pnpm -s typecheck',
  ...overrides,
  approval: {
    outcome: 'allowed',
    decidedBy: { kind: 'mode', mode: 'auto' },
    asked: false,
    decidedAt: '2026-10-24T03:00:00.000Z',
    ...overrides.approval,
  },
});

const askedOverWeb = (input: string, patterns?: string[]): ApprovalLogEntry =>
  entry({
    input,
    project: '/Users/tester/dev/app',
    ...(patterns ? { patterns } : {}),
    approval: {
      asked: true,
      askedBecause: 'Asked because this reply read content from the web (web_fetch).',
      decidedBy: { kind: 'user', answer: 'always' },
      requestedAt: '2026-10-24T03:00:00.000Z',
      decidedAt: '2026-10-24T03:00:30.000Z',
    },
  });

describe('entryPatterns', () => {
  it('uses the recorded patterns, without the home folder', () => {
    expect(entryPatterns(entry({ patterns: ['/Users/tester/bin/x *', 'git commit *'] }), '/Users/tester')).toEqual([
      '~/bin/x *',
      'git commit *',
    ]);
  });

  it('falls back to the first words of each sub-command for older entries', () => {
    expect(entryPatterns(entry({ input: 'git status --short | head -20; pnpm -s test x' }))).toEqual([
      'git status *',
      'head *',
      'pnpm -s *',
    ]);
  });

  it('does not split inside quotes or take block keywords for programs', () => {
    expect(
      entryPatterns(entry({ input: 'for s in a b; do echo "$s"; node -e \'const a = 1; a | 2\'; done; X=1 make' }))
    ).toEqual(['for *', 'echo *', 'node *']);
  });

  it('never carries a non-shell input, which is a path or URL', () => {
    expect(entryPatterns(entry({ tool: 'web_fetch', input: 'https://example.com/secret?token=x' }))).toEqual([
      'web_fetch',
    ]);
  });
});

describe('summarizeApprovals', () => {
  const entries = [
    entry(),
    askedOverWeb('pnpm -s typecheck', ['pnpm typecheck *']),
    askedOverWeb('pnpm -s typecheck', ['pnpm typecheck *']),
    askedOverWeb('git push origin main', ['git push *']),
    entry({
      input: 'rm -rf build',
      approval: {
        asked: true,
        outcome: 'denied',
        decidedBy: { kind: 'user', answer: 'deny' },
        requestedAt: '2026-10-24T03:00:00.000Z',
        decidedAt: '2026-10-24T03:00:10.000Z',
      },
    }),
    entry({
      approval: { outcome: 'denied', decidedBy: { kind: 'system', reason: 'error', detail: 'ENAMETOOLONG' } },
    }),
  ];

  it('counts what asked, why, and how it was answered', () => {
    const summary = summarizeApprovals(entries);
    expect(summary).toMatchObject({ total: 6, asked: 4, askedAllowed: 3, askedDenied: 1 });
    expect(summary.waited).toEqual({ total: 100, median: 30 });
    expect(summary.reasons).toEqual([
      { reason: 'untrusted content (web_fetch)', count: 3 },
      { reason: "the tool's own check (outside folder, outbound, .env, ...) or ask mode", count: 1 },
    ]);
    expect(summary.deciders[0]).toEqual({ decider: 'user: always', count: 3 });
    expect(summary.refusals).toEqual([{ pattern: 'bash_execute: pnpm -s *', count: 1 }]);
  });

  it('groups prompts by tool, pattern and project folder name, and picks the always-allowed ones', () => {
    const summary = summarizeApprovals(entries);
    expect(summary.prompted[0]).toEqual({
      tool: 'bash_execute',
      pattern: 'pnpm typecheck *',
      project: 'app',
      asked: 2,
      allowed: 2,
      denied: 0,
    });
    expect(summary.alwaysAllowed.map(row => row.pattern)).toEqual(['pnpm typecheck *']);
  });

  it('formats a report with no full command, path or URL in it', () => {
    const report = formatApprovalSummary(summarizeApprovals(entries));
    expect(report).toContain('| bash_execute | `pnpm typecheck *` | app | 2 | 2 | 0 |');
    expect(report).not.toContain('origin main');
    expect(report).not.toContain('/Users/tester');
  });
});

describe('readApprovalLog', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'approval-summary-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads the rotated file first and skips malformed lines and missing files', async () => {
    const rotated = join(directory, 'approval-log.1.jsonl');
    const current = join(directory, 'approval-log.jsonl');
    await writeFile(rotated, `${JSON.stringify(entry({ ts: 'a' }))}\n{"cut short`);
    await writeFile(current, `${JSON.stringify(entry({ ts: 'b' }))}\n\n${JSON.stringify({ ts: 'c' })}\n`);
    const read = await readApprovalLog([rotated, current, join(directory, 'missing.jsonl')]);
    expect(read.map(item => item.ts)).toEqual(['a', 'b']);
  });
});
