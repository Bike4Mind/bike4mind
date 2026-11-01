import type { ChatProject, ChatSessionSummary } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { relayHoldReason, resolveSessionRef } from './sessionRef';

function session(id: string, title: string, directory?: string): ChatSessionSummary {
  return {
    id,
    title,
    messageCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    approvalMode: 'ask',
    ...(directory ? { project: project(directory) } : {}),
  } as ChatSessionSummary;
}

function project(directory: string): ChatProject {
  return { directory } as ChatProject;
}

const ALPHA = session('aaaaaaaa-1111-4111-8111-111111111111', 'Fix login', '/work/web');
const ALPHA_TWIN = session('aaaaaaab-2222-4222-8222-222222222222', 'Fix login', '/work/api');
const BETA = session('bbbbbbbb-3333-4333-8333-333333333333', 'Release notes');

describe('resolveSessionRef', () => {
  const all = [ALPHA, ALPHA_TWIN, BETA];

  it('takes a full id, a unique prefix, or an exact title regardless of case', () => {
    expect(resolveSessionRef(BETA.id, all)).toMatchObject({ ok: true, session: BETA });
    expect(resolveSessionRef('bbbbbbbb', all)).toMatchObject({ ok: true, session: BETA });
    expect(resolveSessionRef('@release NOTES', all)).toMatchObject({ ok: true, session: BETA });
  });

  it('names every candidate when a title or prefix is shared, rather than picking one', () => {
    const byTitle = resolveSessionRef('fix login', all);
    expect(byTitle).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(byTitle.ok ? '' : byTitle.message).toContain('aaaaaaaa');
    expect(byTitle.ok ? '' : byTitle.message).toContain('(api)');
    expect(resolveSessionRef('aaaaaa', all)).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('does not match part of a title, or a prefix too short to mean anything', () => {
    expect(resolveSessionRef('Fix', all)).toMatchObject({ ok: false, reason: 'no-target' });
    expect(resolveSessionRef('bbbb', all)).toMatchObject({ ok: false, reason: 'no-target' });
    expect(resolveSessionRef('  ', all)).toMatchObject({ ok: false, reason: 'no-target' });
  });
});

describe('relayHoldReason', () => {
  const web = project('/work/web');

  it('delivers within one project at the same or a stricter mode', () => {
    expect(relayHoldReason({ project: web, approvalMode: 'auto' }, { project: web, approvalMode: 'auto' })).toBeNull();
    expect(relayHoldReason({ project: web, approvalMode: 'full' }, { project: web, approvalMode: 'ask' })).toBeNull();
  });

  it('holds for another project, a missing project on either side, or a looser receiver', () => {
    const api = project('/work/api');
    expect(relayHoldReason({ project: web, approvalMode: 'full' }, { project: api, approvalMode: 'ask' })).toBe(
      'other-project'
    );
    expect(relayHoldReason({ project: web, approvalMode: 'ask' }, { approvalMode: 'ask' })).toBe('other-project');
    expect(relayHoldReason({ project: web, approvalMode: 'ask' }, { project: web, approvalMode: 'auto' })).toBe(
      'looser-mode'
    );
  });
});
