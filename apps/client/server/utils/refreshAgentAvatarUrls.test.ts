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
// exercises the owner gate, not isImageServeable's internals.
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/common')>();
  return { ...actual, isImageServeable: () => true };
});

const { refreshAgentAvatarUrls } = await import('./refreshAgentAvatarUrls');

// A shared agent whose portrait's signed URL has expired, so the refresh path reaches the
// owner-gated write-back. portraitUrl's pathname ("/abc.png") is what maps to the FabFile.
const makeAgent = (): IAgent =>
  ({ name: 'A', visual: { portraitUrl: 'https://bucket.s3.amazonaws.com/abc.png?sig=1' } }) as unknown as IAgent;

const expiredOwnedBy = (userId: string) => ({
  filePath: 'abc.png',
  userId,
  fileUrlExpireAt: new Date(Date.now() - 60 * 60 * 1000), // expired
  fileUrl: 'https://old.example/abc.png',
  mimeType: 'image/png',
  moderationStatus: 'clean',
});

describe('refreshAgentAvatarUrls owner gate', () => {
  beforeEach(() => {
    h.findOne.mockReset().mockResolvedValue(expiredOwnedBy('owner'));
    h.update.mockReset().mockResolvedValue(undefined);
    h.getSignedUrl.mockReset().mockResolvedValue('https://signed.example/new.png');
  });

  it('a shared-agent viewer (non-owner) gets a fresh display URL but never rewrites the record', async () => {
    const [agent] = await refreshAgentAvatarUrls([makeAgent()], 'viewer'); // viewer !== owner
    // Display URL is minted for the viewer...
    expect(agent.visual?.portraitUrl).toBe('https://signed.example/new.png');
    // ...but the owner's FabFile is NOT mutated by a non-owner.
    expect(h.update).not.toHaveBeenCalled();
  });

  it('the owner both gets the fresh URL and persists it back onto their own record', async () => {
    const [agent] = await refreshAgentAvatarUrls([makeAgent()], 'owner'); // owner === owner
    expect(agent.visual?.portraitUrl).toBe('https://signed.example/new.png');
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ fileUrl: 'https://signed.example/new.png', userId: 'owner' })
    );
  });
});
