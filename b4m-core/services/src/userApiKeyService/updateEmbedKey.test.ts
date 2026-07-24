import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateEmbedKey } from './updateEmbedKey';
import { ApiKeyScope, IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

// Seed a stored key and echo mutations back so we can assert what was persisted.
const makeRepo = (stored: Partial<IUserApiKeyDocument> | null, orgKey: Partial<IUserApiKeyDocument> | null = null) =>
  ({
    findByUserIdAndId: vi.fn().mockResolvedValue(stored),
    findByOrganizationIdsAndId: vi.fn().mockResolvedValue(orgKey),
    update: vi.fn().mockResolvedValue(undefined),
  }) as unknown as IUserApiKeyRepository;

const makeOrgs = (administeredOrgIds: string[] = []) =>
  ({
    findIdsAdministeredBy: vi.fn().mockResolvedValue(administeredOrgIds),
  }) as unknown as { findIdsAdministeredBy: (userId: string) => Promise<string[]> };

const deps = (repo: IUserApiKeyRepository, orgs = makeOrgs()) => ({ db: { userApiKeys: repo, organizations: orgs } });

const embedKey = (): Partial<IUserApiKeyDocument> => ({
  id: 'key-1',
  name: 'Embed key',
  scopes: [ApiKeyScope.EMBED_CHAT],
  agentId: 'agent-1',
  allowedOrigins: ['https://example.com'],
  branding: { displayName: 'Acme Assistant' },
});

describe('userApiKeyService - updateEmbedKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates only the provided fields, leaving the rest intact', async () => {
    const stored = embedKey();
    const repo = makeRepo(stored);
    const orgs = makeOrgs();

    const result = await updateEmbedKey('user1', { keyId: 'key-1', agentId: 'agent-2' }, deps(repo, orgs));

    expect(result.agentId).toBe('agent-2');
    expect(result.allowedOrigins).toEqual(['https://example.com']);
    expect(result.branding).toEqual({ displayName: 'Acme Assistant' });
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agent-2' }));
    // Lazy resolution: a minter-owned hit never consults the org-admin path.
    expect(orgs.findIdsAdministeredBy).not.toHaveBeenCalled();
    expect(repo.findByOrganizationIdsAndId).not.toHaveBeenCalled();
  });

  it('normalizes and dedupes a replacement origin list', async () => {
    const repo = makeRepo(embedKey());

    const result = await updateEmbedKey(
      'user1',
      { keyId: 'key-1', allowedOrigins: ['https://A.example.com', 'https://a.example.com'] },
      deps(repo)
    );

    expect(result.allowedOrigins).toEqual(['https://a.example.com']);
  });

  it('clears the allow-list when given an empty array', async () => {
    const repo = makeRepo(embedKey());

    const result = await updateEmbedKey('user1', { keyId: 'key-1', allowedOrigins: [] }, deps(repo));

    expect(result.allowedOrigins).toEqual([]);
    expect(repo.update).toHaveBeenCalledWith(expect.objectContaining({ allowedOrigins: [] }));
  });

  it('replaces the branding fields', async () => {
    const repo = makeRepo(embedKey());

    const result = await updateEmbedKey(
      'user1',
      { keyId: 'key-1', branding: { displayName: 'New Name', primaryColor: '#336699' } },
      deps(repo)
    );

    expect(result.branding).toEqual({ displayName: 'New Name', primaryColor: '#336699' });
  });

  it('lets an org admin configure a key billed to an org they administer (not the minter)', async () => {
    // Minter-miss, but the caller administers org-1 and the key is org-1-billed.
    const repo = makeRepo(null, embedKey());
    const orgs = makeOrgs(['org-1']);

    const result = await updateEmbedKey('admin-user', { keyId: 'key-1', agentId: 'agent-2' }, deps(repo, orgs));

    expect(result.agentId).toBe('agent-2');
    expect(orgs.findIdsAdministeredBy).toHaveBeenCalledWith('admin-user');
    expect(repo.findByOrganizationIdsAndId).toHaveBeenCalledWith(['org-1'], 'key-1');
    expect(repo.update).toHaveBeenCalled();
  });

  it("throws NotFound when the caller neither minted nor administers the key's org", async () => {
    // Minter-miss AND the org-admin resolver misses (caller administers nothing / a different org).
    const repo = makeRepo(null, null);
    const orgs = makeOrgs([]);

    await expect(
      updateEmbedKey('other-user', { keyId: 'key-1', agentId: 'agent-2' }, deps(repo, orgs))
    ).rejects.toThrow(/not found/);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects configuring a key without the embed:chat scope', async () => {
    const repo = makeRepo({ ...embedKey(), scopes: [ApiKeyScope.AI_CHAT] });

    await expect(updateEmbedKey('user1', { keyId: 'key-1', agentId: 'agent-2' }, deps(repo))).rejects.toThrow(
      /Only embed:chat keys/
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('throws NotFound when the key does not belong to the user', async () => {
    const repo = makeRepo(null);

    await expect(updateEmbedKey('user1', { keyId: 'key-1', agentId: 'agent-2' }, deps(repo))).rejects.toThrow(
      /not found/
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a malformed origin', async () => {
    const repo = makeRepo(embedKey());

    await expect(
      updateEmbedKey('user1', { keyId: 'key-1', allowedOrigins: ['http://example.com'] }, deps(repo))
    ).rejects.toThrow(/normalized https origin/);
    expect(repo.update).not.toHaveBeenCalled();
  });

  // Branding format validation (shared EmbedBrandingSchema): removing the schema
  // from updateEmbedKeySchema lets any of these persist.
  it.each([
    ['a javascript: logo URL', { logoUrl: 'javascript:alert(1)' }],
    ['an http: logo URL', { logoUrl: 'http://example.com/logo.png' }],
    ['a non-hex primaryColor', { primaryColor: 'red;}body{background:url(//evil)' }],
    ['an overlong displayName', { displayName: 'a'.repeat(65) }],
  ])('rejects branding with %s', async (_label, branding) => {
    const repo = makeRepo(embedKey());

    await expect(updateEmbedKey('user1', { keyId: 'key-1', branding }, deps(repo))).rejects.toThrow();
    expect(repo.update).not.toHaveBeenCalled();
  });
});
