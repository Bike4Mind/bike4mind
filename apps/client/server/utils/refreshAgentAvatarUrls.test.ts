import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IAgent } from '@bike4mind/common';

// Hoisted so the vi.mock factories below can reference them (vi.mock is hoisted above imports).
const h = vi.hoisted(() => ({
  findOne: vi.fn(),
  update: vi.fn().mockResolvedValue(undefined),
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/new.png'),
}));

vi.mock('@bike4mind/database', () => ({ fabFileRepository: { findOne: h.findOne, update: h.update } }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: h.getSignedUrl }) }));
// Keep the rest of common (IAgent, etc.); only force the serveability gate true so the test
// exercises the access/owner gate, not isImageServeable's internals.
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return { ...actual, isImageServeable: () => true };
});

const { refreshAgentAvatarUrls } = await import('./refreshAgentAvatarUrls');

const ORIGINAL_PORTRAIT = 'https://bucket.s3.amazonaws.com/abc.png?sig=1';

// An agent owned by `ownerId` whose portrait's pathname ("/abc.png") maps to a FabFile.
const makeAgent = (ownerId = 'owner'): IAgent =>
  ({ name: 'A', userId: ownerId, visual: { portraitUrl: ORIGINAL_PORTRAIT } }) as unknown as IAgent;

// An expired FabFile so the refresh path is reached; vary owner and global-read to probe the gate.
const expiredFile = (userId: string, isGlobalRead = false) => ({
  filePath: 'abc.png',
  userId,
  isGlobalRead,
  fileUrlExpireAt: new Date(Date.now() - 60 * 60 * 1000), // expired
  fileUrl: 'https://old.example/abc.png',
  mimeType: 'image/png',
  moderationStatus: 'clean',
});

describe('refreshAgentAvatarUrls access gate', () => {
  beforeEach(() => {
    h.findOne.mockReset();
    h.update.mockReset().mockResolvedValue(undefined);
    h.getSignedUrl.mockReset().mockResolvedValue('https://signed.example/new.png');
  });

  it('a shared-agent viewer (non-owner) gets a fresh display URL but never rewrites the record', async () => {
    // File is owned by the agent owner (the real-world invariant) -> served to any viewer.
    h.findOne.mockResolvedValue(expiredFile('owner'));
    const [agent] = await refreshAgentAvatarUrls([makeAgent('owner')], 'viewer'); // viewer !== owner
    expect(agent.visual?.portraitUrl).toBe('https://signed.example/new.png');
    // ...but the owner's FabFile is NOT mutated by a non-owner.
    expect(h.update).not.toHaveBeenCalled();
  });

  it('the owner both gets the fresh URL and persists it back onto their own record', async () => {
    h.findOne.mockResolvedValue(expiredFile('owner'));
    const [agent] = await refreshAgentAvatarUrls([makeAgent('owner')], 'owner'); // owner === owner
    expect(agent.visual?.portraitUrl).toBe('https://signed.example/new.png');
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ fileUrl: 'https://signed.example/new.png', userId: 'owner' })
    );
  });

  it('refuses to sign a foreign private file the agent portrait points at (exploit)', async () => {
    // Agent owned by attacker, portrait pointed at a victim's private file resolved by path alone.
    h.findOne.mockResolvedValue(expiredFile('victim', false));
    const [agent] = await refreshAgentAvatarUrls([makeAgent('attacker')], 'attacker');
    // No signed URL is minted, the stored (unusable) URL is returned unchanged, no write-back.
    expect(h.getSignedUrl).not.toHaveBeenCalled();
    expect(agent.visual?.portraitUrl).toBe(ORIGINAL_PORTRAIT);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('still serves a globally readable file not owned by the agent owner', async () => {
    h.findOne.mockResolvedValue(expiredFile('other', true)); // isGlobalRead
    const [agent] = await refreshAgentAvatarUrls([makeAgent('owner')], 'viewer');
    expect(agent.visual?.portraitUrl).toBe('https://signed.example/new.png');
    // Write-back is still owner-of-file gated, so a non-owner viewer does not rewrite it.
    expect(h.update).not.toHaveBeenCalled();
  });
});
