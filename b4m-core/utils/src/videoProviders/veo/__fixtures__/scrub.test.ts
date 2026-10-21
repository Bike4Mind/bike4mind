import { describe, expect, it } from 'vitest';
import { assertNoSecret, scrubBody, scrubUrl } from './scrub';

describe('veo fixture scrubber', () => {
  it('redacts inline image data but keeps its size', () => {
    const body = { instances: [{ prompt: 'p', image: { bytesBase64Encoded: 'QUJDRA==', mimeType: 'image/png' } }] };
    expect(scrubBody(body)).toEqual({
      instances: [{ prompt: 'p', image: { bytesBase64Encoded: '<redacted:base64 8 chars>', mimeType: 'image/png' } }],
    });
  });

  it('drops the query string from download URIs', () => {
    expect(scrubUrl('https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media&key=SECRET')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/files/abc:download'
    );
  });

  it('scrubs URIs nested anywhere in an operation', () => {
    const operation = {
      response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://x.example/v?sig=abc' } }] } },
    };
    expect(scrubBody(operation)).toEqual({
      response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://x.example/v' } }] } },
    });
  });

  it('refuses to write a fixture containing the key', () => {
    expect(() => assertNoSecret('{"uri":"https://x?key=AQ.secret"}', 'AQ.secret')).toThrow(/API key/);
    expect(() => assertNoSecret('{"ok":true}', 'AQ.secret')).not.toThrow();
    expect(() => assertNoSecret('{"ok":true}', '')).not.toThrow();
  });
});
