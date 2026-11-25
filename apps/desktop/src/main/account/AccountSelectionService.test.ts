import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { describe, expect, it, vi } from 'vitest';
import type { AccountProfile, AccountSelection } from '@shared/account';
import { PreferenceFile } from '../preferenceFile';
import {
  AccountSelectionService,
  organizationsPath,
  SIGNED_OUT_SELECTION,
  parseStoredAccountSelections,
  type StoredAccountSelections,
} from './AccountSelectionService';

const PROFILE: AccountProfile = { credits: { balance: 900, monthlyAllowance: null }, plan: null, tier: 'free' };
const ACME = { id: 'org-1', name: 'Acme', currentCredits: 5000, seats: 4, stripeCustomerId: 'ignored' };
const BETA = { id: 'org-2', name: 'Beta', currentCredits: 0 };

async function storeFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'billing-account-')), 'billing-account.json');
}

async function setup({
  file,
  organizations = [ACME, BETA],
  userId = 'user-1',
  loaded = true,
}: { file?: string; organizations?: unknown[] | Error; userId?: string; loaded?: boolean } = {}) {
  const path = file ?? (await storeFile());
  const store = new PreferenceFile<StoredAccountSelections>(path, parseStoredAccountSelections, 'TEST');
  const ready = store.load();
  if (loaded) await ready;
  const get = vi.fn(async (_path: string): Promise<unknown> => {
    if (organizations instanceof Error) throw organizations;
    return { data: organizations, hasMore: false, total: organizations.length };
  });
  const user = { id: userId };
  const onChanged = vi.fn<(selection: AccountSelection) => void>();
  const service = new AccountSelectionService({
    getApiClient: () => ({ get }) as unknown as AuthenticatedApiClient,
    getUserId: () => user.id,
    profile: async () => PROFILE,
    store,
    ready,
    logger: { warn: () => undefined },
    onChanged,
  });
  return { service, store, get, onChanged, path, user };
}

describe('AccountSelectionService', () => {
  it('starts on Personal and lists each organization with its pool', async () => {
    const { service, get } = await setup();
    expect(service.payer()).toEqual({ organization_id: null });

    const selection = await service.selection(true);
    expect(get).toHaveBeenCalledWith(organizationsPath('user-1'));
    expect(selection.selected).toEqual({ id: 'user-1', name: 'Personal', personal: true, credits: 900 });
    expect(selection.accounts.map(account => [account.id, account.credits])).toEqual([
      ['user-1', 900],
      ['org-1', 5000],
      ['org-2', 0],
    ]);
    expect(selection.accounts[1]).toEqual({ id: 'org-1', name: 'Acme', personal: false, credits: 5000, seats: 4 });
  });

  it('scopes the organization query to the user, as the web does for site admins', () => {
    expect(decodeURIComponent(organizationsPath('user-1'))).toContain('filters[userId]=user-1');
  });

  it('remembers the pick per user id and survives a reload', async () => {
    const first = await setup();
    await first.service.selection(true);
    const picked = await first.service.select('org-1');
    expect(picked.selected?.name).toBe('Acme');
    expect(first.service.payer()).toEqual({ organization_id: 'org-1' });

    first.user.id = 'user-2';
    expect(first.service.payer()).toEqual({ organization_id: null });

    const reloaded = await setup({ file: first.path });
    expect(reloaded.service.payer()).toEqual({ organization_id: 'org-1' });
    reloaded.user.id = 'user-2';
    expect(reloaded.service.payer()).toEqual({ organization_id: null });
  });

  it('goes back to Personal when null is picked', async () => {
    const { service } = await setup();
    await service.select('org-1');
    const personal = await service.select(null);
    expect(personal.selected?.personal).toBe(true);
    expect(service.payer()).toEqual({ organization_id: null });
  });

  it('refuses an organization the user is not listed in', async () => {
    const { service } = await setup();
    await expect(service.select('org-9')).rejects.toThrow(/not one of yours/);
    await expect(service.select(42)).rejects.toThrow();
    expect(service.payer()).toEqual({ organization_id: null });
  });

  it('falls back to Personal, and says so, when the remembered organization is gone', async () => {
    const first = await setup();
    await first.service.select('org-2');

    const later = await setup({ file: first.path, organizations: [ACME] });
    // Not yet known to be stale: the server is still the judge.
    expect(later.service.payer()).toEqual({ organization_id: 'org-2' });

    const selection = await later.service.selection(true);
    expect(selection.selected?.personal).toBe(true);
    expect(selection.droppedOrganizationId).toBe('org-2');
    expect(later.service.payer()).toEqual({ organization_id: null });
    expect(later.onChanged).toHaveBeenCalledWith(selection);
    expect(later.store.current().byUser).toEqual({});
  });

  it('keeps the remembered organization when the list cannot be read', async () => {
    const first = await setup();
    await first.service.select('org-1');

    const offline = await setup({ file: first.path, organizations: new Error('offline') });
    const selection = await offline.service.selection(true);
    expect(selection.error).toMatch(/Could not read your organizations/);
    expect(selection.droppedOrganizationId).toBeNull();
    expect(selection.selected).toMatchObject({ id: 'org-1', personal: false, credits: null });
    expect(offline.service.payer()).toEqual({ organization_id: 'org-1' });
  });

  it('answers from the last read unless asked for a fresh one', async () => {
    const { service, get } = await setup();
    await service.selection(true);
    await service.selection(false);
    expect(get).toHaveBeenCalledTimes(1);
    await service.selection(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('answers the signed-in user when a read for the previous user is still in flight', async () => {
    const { service, get, user } = await setup();
    let releaseFirst: (value: unknown) => void = () => undefined;
    get.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseFirst = resolve;
        })
    );
    const first = service.selection(true);

    user.id = 'user-2';
    get.mockResolvedValueOnce({ data: [BETA], hasMore: false, total: 1 });
    const second = await service.selection(true);
    expect(get).toHaveBeenLastCalledWith(organizationsPath('user-2'));
    expect(second.selected?.id).toBe('user-2');
    expect(second.accounts.map(account => account.id)).toEqual(['user-2', 'org-2']);

    releaseFirst({ data: [ACME], hasMore: false, total: 1 });
    expect((await first).selected?.id).toBe('user-2');
    expect((await service.selection(false)).accounts.map(account => account.id)).toEqual(['user-2', 'org-2']);
  });

  it('tells the windows on sign-out, and on sign-in re-checks the remembered organization', async () => {
    const first = await setup();
    await first.service.select('org-2');
    const { service, get, onChanged, user } = await setup({ file: first.path, organizations: [ACME] });

    await service.authChanged('user-1');
    expect(get).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ droppedOrganizationId: 'org-2' }));

    await service.authChanged(null);
    expect(onChanged).toHaveBeenLastCalledWith(SIGNED_OUT_SELECTION);

    user.id = 'user-1';
    await service.authChanged('user-1');
    expect(get).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ selected: expect.objectContaining({ id: 'user-1', personal: true }) })
    );
  });

  it("announces a switch to another user with that user's selection", async () => {
    const { service, onChanged, user } = await setup();
    await service.authChanged('user-1');
    user.id = 'user-2';
    await service.authChanged('user-2');
    expect(onChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ selected: expect.objectContaining({ id: 'user-2' }) })
    );
  });

  it('keeps a pick made while the remembered selections are still loading', async () => {
    const first = await setup();
    await first.service.select('org-2');

    const starting = await setup({ file: first.path, loaded: false });
    const picked = await starting.service.select('org-1');
    expect(picked.selected?.id).toBe('org-1');
    expect(starting.service.payer()).toEqual({ organization_id: 'org-1' });
    expect(JSON.parse(await readFile(first.path, 'utf8'))).toEqual({ byUser: { 'user-1': 'org-1' } });
  });

  it('says the organization list could not be loaded when a pick cannot be checked', async () => {
    const { service } = await setup({ organizations: new Error('offline') });
    await expect(service.select('org-1')).rejects.toThrow(/Could not load your organizations.*Try again/);
    expect(service.payer()).toEqual({ organization_id: null });
  });
});
