import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));

import {
  createRegInvites,
  deleteRegInvites,
  getRegInvitesFromServer,
  submitReferral,
  submitUserInvitation,
  updateRegInvite,
  updateRegInvites,
} from './regInviteAPICalls';

const invitation = { friendEmail: ['friend@example.com'], emailTitle: 'Join', emailBody: 'Hello' };

describe('regInviteAPICalls', () => {
  beforeEach(() => {
    api.get.mockReset().mockResolvedValue({ data: 'got' });
    api.post.mockReset().mockResolvedValue({ data: 'posted' });
  });

  it('lists the invites', async () => {
    expect(await getRegInvitesFromServer()).toBe('got');
    expect(api.get).toHaveBeenCalledWith('/api/reg-invites');
  });

  it.each([
    [
      'a bulk update with its reason',
      () => updateRegInvites({ ids: ['i1'], reason: 'why' }),
      '/api/reg-invites/update',
      { ids: ['i1'], reason: 'why' },
    ],
    [
      'a single-code update',
      () => updateRegInvite('i1', { unlimitedUse: true }),
      '/api/reg-invites/update',
      { ids: ['i1'], unlimitedUse: true },
    ],
    ['a create', () => createRegInvites({ multiple: 2 }), '/api/reg-invites/create', { multiple: 2 }],
    ['a delete', () => deleteRegInvites(['i1']), '/api/reg-invites/delete', { ids: ['i1'] }],
    ['a referral', () => submitReferral(invitation), '/api/reg-invites/refer', invitation],
    ['a user invitation', () => submitUserInvitation(invitation), '/api/reg-invites/user-invite', invitation],
  ])('posts %s and returns the body', async (_label, call, url, body) => {
    expect(await call()).toBe('posted');
    expect(api.post).toHaveBeenCalledWith(url, body);
  });
});
