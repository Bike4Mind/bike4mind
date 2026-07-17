import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { Config } from '@server/utils/config';
import {
  signDraftUploadToken,
  verifyDraftUploadToken,
  mintDraftUploadUrl,
  DRAFT_UPLOAD_EXPIRY_SECONDS,
  type DraftUploadStorage,
} from './draftUploadUrl';

const AUDIENCE = 'publish-draft-upload';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('signDraftUploadToken / verifyDraftUploadToken', () => {
  it('round-trips the pinned claims', () => {
    const token = signDraftUploadToken({ draftId: 'd1', path: 'index.html' });
    expect(verifyDraftUploadToken(token)).toEqual({ draftId: 'd1', path: 'index.html' });
  });

  it('rejects a tampered token', () => {
    const token = signDraftUploadToken({ draftId: 'd1', path: 'index.html' });
    // Flip the final character of the signature segment.
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
    expect(verifyDraftUploadToken(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ draftId: 'd1', path: 'index.html' }, Config.JWT_SECRET, {
      audience: AUDIENCE,
      expiresIn: '-10s',
    });
    expect(verifyDraftUploadToken(expired)).toBeNull();
  });

  it('rejects a token minted for a different audience', () => {
    const wrongAud = jwt.sign({ draftId: 'd1', path: 'index.html' }, Config.JWT_SECRET, {
      audience: 'some-other-audience',
      expiresIn: DRAFT_UPLOAD_EXPIRY_SECONDS,
    });
    expect(verifyDraftUploadToken(wrongAud)).toBeNull();
  });
});

describe('mintDraftUploadUrl', () => {
  const makeStorage = (url: string): DraftUploadStorage => ({
    getSignedUrl: vi.fn(async () => url),
  });

  it('hosted: returns the presigned S3 PUT URL from storage', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    const storage = makeStorage('https://s3.example/presigned-put');
    const url = await mintDraftUploadUrl({
      storage,
      key: 'drafts/d1/index.html',
      draftId: 'd1',
      path: 'index.html',
      mimeType: 'text/html',
      expiresIn: DRAFT_UPLOAD_EXPIRY_SECONDS,
    });
    expect(url).toBe('https://s3.example/presigned-put');
    expect(storage.getSignedUrl).toHaveBeenCalledWith('drafts/d1/index.html', 'put', {
      expiresIn: DRAFT_UPLOAD_EXPIRY_SECONDS,
      ContentType: 'text/html',
    });
  });

  it('self-host: returns a same-origin proxy URL carrying a valid token, without touching storage', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    const storage = makeStorage('https://should-not-be-used');
    const url = await mintDraftUploadUrl({
      storage,
      key: 'drafts/d1/assets/app.js',
      draftId: 'd1',
      path: 'assets/app.js',
      mimeType: 'text/javascript',
      expiresIn: DRAFT_UPLOAD_EXPIRY_SECONDS,
    });

    expect(storage.getSignedUrl).not.toHaveBeenCalled();
    expect(url.startsWith('/api/publish/artifact/draft-upload?')).toBe(true);

    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('draftId')).toBe('d1');
    expect(params.get('path')).toBe('assets/app.js');
    expect(verifyDraftUploadToken(params.get('token') ?? '')).toEqual({ draftId: 'd1', path: 'assets/app.js' });
  });
});
