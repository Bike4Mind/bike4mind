import { describe, it, expect, vi } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { resolveOwnedGeneratedImageUrl, type OwnedGeneratedImageContext } from './resolveOwnedGeneratedImage';

const OWNED_KEY = '86cdc650-43d2-416e-aca6-23ff4fe23081.jpg';
const SIGNED_URL = 'https://signed.example/generated.jpg';

type SessionStub = { userId: string; users?: { userId: string }[] };

function createContext(options: { sessionIds?: string[]; sessions?: SessionStub[]; wired?: boolean } = {}) {
  const { sessionIds = ['s1'], sessions = [{ userId: 'u1' }], wired = true } = options;
  const findSessionIdsByImage = vi.fn().mockResolvedValue(sessionIds);
  const findAllByIds = vi.fn().mockResolvedValue(sessions);
  const getSignedUrl = vi.fn().mockResolvedValue(SIGNED_URL);
  const context = {
    userId: 'u1',
    logger: { warn: vi.fn() },
    db: wired ? { quests: { findSessionIdsByImage }, sessions: { findAllByIds } } : {},
    imageGenerateStorage: { upload: vi.fn(), getSignedUrl, getPublicUrl: vi.fn() },
  } as unknown as OwnedGeneratedImageContext;
  return { context, findSessionIdsByImage, findAllByIds, getSignedUrl };
}

describe('resolveOwnedGeneratedImageUrl', () => {
  it('signs a well-formed key the caller owns', async () => {
    const { context, findSessionIdsByImage, findAllByIds, getSignedUrl } = createContext();

    await expect(resolveOwnedGeneratedImageUrl(OWNED_KEY, context)).resolves.toBe(SIGNED_URL);
    expect(findSessionIdsByImage).toHaveBeenCalledWith(OWNED_KEY);
    expect(findAllByIds).toHaveBeenCalledWith(['s1'], { includeDeleted: true });
    expect(getSignedUrl).toHaveBeenCalledWith(OWNED_KEY);
  });

  it.each(['png', 'jpeg', 'webp', 'gif'])('accepts the .%s extension', async extension => {
    const { context } = createContext();
    const key = `86cdc650-43d2-416e-aca6-23ff4fe23081.${extension}`;

    await expect(resolveOwnedGeneratedImageUrl(key, context)).resolves.toBe(SIGNED_URL);
  });

  it('refuses a key whose session belongs to another user', async () => {
    const { context, getSignedUrl } = createContext({ sessions: [{ userId: 'someone-else' }] });

    await expect(resolveOwnedGeneratedImageUrl(OWNED_KEY, context)).rejects.toThrow(NotFoundError);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a key the caller reaches only as a share recipient', async () => {
    const { context, getSignedUrl } = createContext({
      sessions: [{ userId: 'someone-else', users: [{ userId: 'u1' }] }],
    });

    await expect(resolveOwnedGeneratedImageUrl(OWNED_KEY, context)).rejects.toThrow(NotFoundError);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a key no quest references', async () => {
    const { context, findAllByIds, getSignedUrl } = createContext({ sessionIds: [] });

    await expect(resolveOwnedGeneratedImageUrl(OWNED_KEY, context)).rejects.toThrow(NotFoundError);
    expect(findAllByIds).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('gives a foreign key and an unknown key the same error message', async () => {
    const foreign = createContext({ sessions: [{ userId: 'someone-else' }] });
    const unknown = createContext({ sessionIds: [] });

    const foreignError = await resolveOwnedGeneratedImageUrl(OWNED_KEY, foreign.context).catch((e: Error) => e);
    const unknownError = await resolveOwnedGeneratedImageUrl(OWNED_KEY, unknown.context).catch((e: Error) => e);
    expect(foreignError).toBeInstanceOf(Error);
    expect((foreignError as Error).message).toBe((unknownError as Error).message);
  });

  it.each([
    ['a traversal path', '../x'],
    ['a nested path', 'a/b.png'],
    ['a key with a directory prefix', `generated/${OWNED_KEY}`],
    ['an uppercase key', OWNED_KEY.toUpperCase()],
    ['an uppercase extension', '86cdc650-43d2-416e-aca6-23ff4fe23081.PNG'],
    ['a trailing character', `${OWNED_KEY}x`],
    ['a leading character', `x${OWNED_KEY}`],
    ['a trailing newline', `${OWNED_KEY}\n`],
    ['a non-image extension', '86cdc650-43d2-416e-aca6-23ff4fe23081.mp3'],
    ['a missing extension', '86cdc650-43d2-416e-aca6-23ff4fe23081'],
    ['a non-uuid name', 'generated-key.png'],
    ['an empty string', ''],
  ])('refuses %s without querying', async (_label, key) => {
    const { context, findSessionIdsByImage, getSignedUrl } = createContext();

    await expect(resolveOwnedGeneratedImageUrl(key, context)).rejects.toThrow(NotFoundError);
    expect(findSessionIdsByImage).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('fails closed when the host did not wire the ownership lookup', async () => {
    const { context, getSignedUrl } = createContext({ wired: false });

    await expect(resolveOwnedGeneratedImageUrl(OWNED_KEY, context)).rejects.toThrow(NotFoundError);
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(context.logger.warn).toHaveBeenCalled();
  });

  it('fails closed when only the quest lookup is wired', async () => {
    const { context, findSessionIdsByImage, getSignedUrl } = createContext();
    context.db.sessions = {};

    await expect(resolveOwnedGeneratedImageUrl(OWNED_KEY, context)).rejects.toThrow(NotFoundError);
    expect(findSessionIdsByImage).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
