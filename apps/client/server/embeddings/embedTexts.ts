/** OpenAI's `encoding_format: "base64"`: the little-endian float32 bytes of the vector. */
export function encodeEmbeddingBase64(vector: readonly number[]): string {
  const buffer = Buffer.alloc(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT));
  return buffer.toString('base64');
}
