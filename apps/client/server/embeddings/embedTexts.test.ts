import { describe, expect, it } from 'vitest';
import { encodeEmbeddingBase64 } from './embedTexts';

describe('encodeEmbeddingBase64', () => {
  it('encodes little-endian float32, the format OpenAI clients decode', () => {
    const encoded = encodeEmbeddingBase64([1, -0.5]);
    const decoded = new Float32Array(new Uint8Array(Buffer.from(encoded, 'base64')).buffer);
    expect(Array.from(decoded)).toEqual([1, -0.5]);
  });
});
