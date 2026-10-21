import { describe, expect, it } from 'vitest';
import type { ChatSessionSummary } from '@shared/chat';
import { folderToRemember } from './recentFolderToRecord';

function session(directory?: string): ChatSessionSummary {
  return { project: directory ? { directory } : undefined } as unknown as ChatSessionSummary;
}

describe('folderToRemember', () => {
  it('returns the resolved project directory, not the requested path', () => {
    expect(folderToRemember({ directory: '~/app/../app' }, { ok: true, session: session('/Users/me/app') })).toBe(
      '/Users/me/app'
    );
  });

  it('returns null when the request names no directory', () => {
    expect(folderToRemember({}, { ok: true, session: session('/Users/me/app') })).toBeNull();
  });

  it('returns null when the request failed', () => {
    expect(folderToRemember({ directory: '/Users/me/app' }, { ok: false })).toBeNull();
  });

  it('returns null when the session has no project', () => {
    expect(folderToRemember({ directory: '/Users/me/app' }, { ok: true, session: session() })).toBeNull();
  });

  it('returns null when there is no request', () => {
    expect(folderToRemember(undefined, { ok: true, session: session('/Users/me/app') })).toBeNull();
  });
});
