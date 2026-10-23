// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FIRST_SIGNUP_SESSION_KEY,
  FIRST_SIGNUP_SESSION_TTL_MS,
  isFirstSignupSession,
  markFirstSignupSession,
} from './firstSignupSession';

describe('firstSignupSession', () => {
  beforeEach(() => localStorage.clear());

  it('honours a fresh marker for the marked user only', () => {
    markFirstSignupSession('u1');
    expect(isFirstSignupSession('u1')).toBe(true);
    expect(isFirstSignupSession('u2')).toBe(false);
  });

  it('returns false without a user id', () => {
    markFirstSignupSession('u1');
    expect(isFirstSignupSession(undefined)).toBe(false);
  });

  it('expires after the TTL and removes the marker', () => {
    markFirstSignupSession('u1');
    const { markedAt } = JSON.parse(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY) as string);
    expect(isFirstSignupSession('u1', markedAt + FIRST_SIGNUP_SESSION_TTL_MS - 1)).toBe(true);
    expect(isFirstSignupSession('u1', markedAt + FIRST_SIGNUP_SESSION_TTL_MS)).toBe(false);
    expect(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY)).toBeNull();
  });

  it('removes a legacy plain-string marker', () => {
    localStorage.setItem(FIRST_SIGNUP_SESSION_KEY, 'u1');
    expect(isFirstSignupSession('u1')).toBe(false);
    expect(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY)).toBeNull();
  });

  it('removes a marker belonging to another user', () => {
    markFirstSignupSession('u1');
    expect(isFirstSignupSession('u2')).toBe(false);
    expect(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY)).toBeNull();
  });
});
