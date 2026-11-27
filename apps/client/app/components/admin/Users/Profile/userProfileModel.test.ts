import { describe, expect, it } from 'vitest';
import type { UserSignIn, UserSignInsPage } from '@bike4mind/common';
import { latestSignIn } from './userProfileModel';

const entry = (id: string, event: string, at: string): UserSignIn => ({
  id,
  event,
  at: new Date(at),
  result: event === 'login_success' ? 'success' : 'failed',
});
const page = (...entries: UserSignIn[]): UserSignInsPage => ({ entries, nextCursor: null });

describe('latestSignIn', () => {
  it('returns the newest successful sign-in, skipping failures and step-ups ahead of it', () => {
    const pages = [
      page(entry('a', 'login_failed', '2026-11-12T10:00:00Z'), entry('b', 'step_up_success', '2026-11-12T09:00:00Z')),
      page(entry('c', 'login_success', '2026-11-11T09:00:00Z'), entry('d', 'login_success', '2026-11-10T09:00:00Z')),
    ];
    expect(latestSignIn(pages)?.id).toBe('c');
  });

  it('returns null when nothing loaded is a successful sign-in', () => {
    expect(latestSignIn([])).toBeNull();
    expect(latestSignIn([page(entry('a', 'login_failed', '2026-11-12T10:00:00Z'))])).toBeNull();
  });
});
