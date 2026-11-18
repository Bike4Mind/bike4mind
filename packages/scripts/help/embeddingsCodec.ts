/**
 * On-disk format of the help embeddings: a metadata JSON (chunks without vectors) plus a sibling
 * binary of little-endian Float32 vectors in chunk order. Float32 is 4 bytes per value against
 * roughly 9 for the same number as JSON text, which is what keeps the artifact small in the
 * server bundle.
 *
 * Writer: vectorize-help-content.ts. Reader: apps/client/server/help/retrieval.ts. Both must go
 * through this module so the layout lives in one place.
 */

import { createHash } from 'crypto';
import type { HelpEmbeddingChunk, HelpEmbeddingsIndex } from './types.js';

export const HELP_EMBEDDINGS_META_FILE = 'help-embeddings.json';
export const HELP_EMBEDDINGS_VECTORS_FILE = 'help-embeddings.bin';

const BYTES_PER_FLOAT32 = 4;

export type HelpEmbeddingsMetadata = Omit<HelpEmbeddingsIndex, 'chunks'> & {
  chunks: Array<Omit<HelpEmbeddingChunk, 'vector'>>;
  /** Ties this file to its binary: the two are written separately, so a stale pair must not decode. */
  vectorsSha256: string;
};

const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

export type EncodedHelpEmbeddings = {
  metadataJson: string;
  vectors: Buffer;
};

export function encodeHelpEmbeddings(index: HelpEmbeddingsIndex): EncodedHelpEmbeddings {
  const { dimensions } = index;
  const vectors = Buffer.alloc(index.chunks.length * dimensions * BYTES_PER_FLOAT32);

  index.chunks.forEach((chunk, chunkIndex) => {
    if (chunk.vector.length !== dimensions) {
      throw new Error(
        `help embedding chunk "${chunk.slug}" has ${chunk.vector.length} dimensions, expected ${dimensions}`
      );
    }
    chunk.vector.forEach((value, valueIndex) => {
      vectors.writeFloatLE(value, (chunkIndex * dimensions + valueIndex) * BYTES_PER_FLOAT32);
    });
  });

  const metadata: HelpEmbeddingsMetadata = {
    ...index,
    chunks: index.chunks.map(({ vector: _vector, ...rest }) => rest),
    vectorsSha256: sha256Hex(vectors),
  };
  return { metadataJson: JSON.stringify(metadata), vectors };
}

/**
 * Throws when the two files do not describe the same index (a truncated or oversized binary, a
 * binary from another build, or a stale metadata file from the older all-in-JSON format), so a
 * caller can fall back to keyword search instead of scoring against garbage.
 */
export function decodeHelpEmbeddings(metadataJson: string, vectors: Buffer): HelpEmbeddingsIndex {
  const metadata = JSON.parse(metadataJson) as HelpEmbeddingsMetadata;
  const { dimensions, chunks } = metadata;

  const expectedBytes = chunks.length * dimensions * BYTES_PER_FLOAT32;
  if (!Number.isInteger(dimensions) || dimensions <= 0 || vectors.length !== expectedBytes) {
    throw new Error(
      `help embeddings binary is ${vectors.length} bytes, expected ${expectedBytes} ` +
        `(${chunks.length} chunks x ${dimensions} dimensions)`
    );
  }

  if (metadata.vectorsSha256 !== sha256Hex(vectors)) {
    throw new Error('help embeddings binary does not belong to this metadata file (checksum mismatch)');
  }

  const { vectorsSha256: _vectorsSha256, ...index } = metadata;
  return {
    ...index,
    chunks: chunks.map((chunk, chunkIndex) => {
      const vector = new Array<number>(dimensions);
      for (let valueIndex = 0; valueIndex < dimensions; valueIndex++) {
        vector[valueIndex] = vectors.readFloatLE((chunkIndex * dimensions + valueIndex) * BYTES_PER_FLOAT32);
      }
      return { ...chunk, vector };
    }),
  };
}
