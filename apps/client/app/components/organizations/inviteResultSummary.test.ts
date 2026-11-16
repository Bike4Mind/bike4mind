import { describe, expect, it } from 'vitest';
import { summarizeInviteResults } from './inviteResultSummary';

const ok = (): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value: {} });
const fail = (message: string): PromiseSettledResult<unknown> => ({ status: 'rejected', reason: new Error(message) });

describe('summarizeInviteResults', () => {
  it('reports one sent invitation', () => {
    expect(summarizeInviteResults([ok()])).toEqual({ kind: 'success', message: 'Invitation sent' });
  });

  it('reports every invitation sent as one success', () => {
    expect(summarizeInviteResults([ok(), ok(), ok()])).toEqual({ kind: 'success', message: '3 invitations sent' });
  });

  it('reports a partial failure once, listing a repeated reason once', () => {
    expect(summarizeInviteResults([ok(), fail('Organization is full'), fail('Organization is full')])).toEqual({
      kind: 'warning',
      message: '1 of 3 invitations sent; 2 failed. Organization is full',
    });
  });

  it('reports a single failure by its own reason', () => {
    expect(summarizeInviteResults([fail('Organization is full')])).toEqual({
      kind: 'error',
      message: 'Organization is full',
    });
  });

  it('reports every invitation failing as one error', () => {
    expect(summarizeInviteResults([fail('Organization is full'), fail('Too many invites')])).toEqual({
      kind: 'error',
      message: 'None of the 2 invitations were sent. Organization is full; Too many invites',
    });
  });
});
