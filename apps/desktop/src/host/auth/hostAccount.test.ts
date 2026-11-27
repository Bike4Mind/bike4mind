import { describe, expect, it } from 'vitest';
import type { AuthState } from '@shared/auth';
import { accountOf } from './hostAccount';

const state = (overrides: Partial<AuthState>): AuthState =>
  ({
    status: 'signed-out',
    environment: { preset: 'hosted', url: 'https://example.test', label: 'Test' },
    hostedAvailable: true,
    storage: 'available',
    busy: 'idle',
    ...overrides,
  }) as AuthState;

describe('accountOf', () => {
  it('names the user and environment once signed in', () => {
    expect(accountOf(state({ status: 'signed-in', user: { id: 'u1' } as AuthState['user'] }))).toEqual({
      userId: 'u1',
      environmentUrl: 'https://example.test',
    });
  });

  it('is null when signed out, or signed in without a user', () => {
    expect(accountOf(state({}))).toBeNull();
    expect(accountOf(state({ status: 'signed-in' }))).toBeNull();
  });
});
