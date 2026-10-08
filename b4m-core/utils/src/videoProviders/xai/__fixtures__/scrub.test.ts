import { describe, expect, it } from 'vitest';
import { assertNoSecret, scrubXaiBody } from './scrub';

describe('scrubXaiBody', () => {
  it('replaces a submitted data URI with its length', () => {
    const uri = 'data:image/png;base64,AAAA';
    expect(scrubXaiBody({ image: { url: uri } })).toEqual({
      image: { url: `<redacted:data-uri ${uri.length} chars>` },
    });
  });

  it('drops the signature query from a pre-signed video url', () => {
    expect(scrubXaiBody({ video: { url: 'https://vidgen.x.ai/a/b.mp4?X-Amz-Signature=secret&x=1' } })).toEqual({
      video: { url: 'https://vidgen.x.ai/a/b.mp4' },
    });
  });

  it('leaves ordinary fields alone', () => {
    const body = { status: 'done', progress: 100, video: { duration: 2, respect_moderation: true } };
    expect(scrubXaiBody(body)).toEqual(body);
  });
});

describe('assertNoSecret', () => {
  it('refuses to serialise a fixture containing the key', () => {
    expect(() => assertNoSecret('{"a":"xai-secret-key"}', 'xai-secret-key')).toThrow('API key');
    expect(() => assertNoSecret('{"a":"b"}', 'xai-secret-key')).not.toThrow();
  });
});
