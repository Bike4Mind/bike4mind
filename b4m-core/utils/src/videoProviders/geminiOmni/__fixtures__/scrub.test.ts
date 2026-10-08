import { describe, expect, it } from 'vitest';
import { assertNoSecret, scrubBody, scrubUrl } from './scrub';

describe('fixture scrubber', () => {
  it('redacts inline image data but keeps its size', () => {
    const body = {
      input: [
        { type: 'image', data: 'QUJDRA==', mime_type: 'image/png' },
        { type: 'text', text: 'p' },
      ],
    };
    expect(scrubBody(body)).toEqual({
      input: [
        { type: 'image', data: '<redacted:base64 8 chars>', mime_type: 'image/png' },
        { type: 'text', text: 'p' },
      ],
    });
  });

  it('drops the query string from download URIs', () => {
    expect(scrubUrl('https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media&key=SECRET')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/files/abc:download'
    );
  });

  it('scrubs URIs nested anywhere in a body', () => {
    const body = { steps: [{ content: [{ type: 'video', uri: 'https://x.example/v?sig=abc' }] }] };
    expect(scrubBody(body)).toEqual({ steps: [{ content: [{ type: 'video', uri: 'https://x.example/v' }] }] });
  });

  it('redacts opaque thought signatures and bare URL strings', () => {
    const body = { steps: [{ type: 'thought', signature: 'EpwcCpkc' }], downloadUri: 'https://x.example/f?key=SECRET' };
    expect(scrubBody(body)).toEqual({
      steps: [{ type: 'thought', signature: '<redacted:signature 8 chars>' }],
      downloadUri: 'https://x.example/f',
    });
  });

  it('refuses to write a fixture that still contains the key', () => {
    expect(() => assertNoSecret('{"a":"AIzaSECRET"}', 'AIzaSECRET')).toThrow(/contains the API key/);
    expect(() => assertNoSecret('{"a":"ok"}', 'AIzaSECRET')).not.toThrow();
  });
});
