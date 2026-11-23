import { describe, it, expect } from 'vitest';

import { decodeHelpEmbeddings, encodeHelpEmbeddings } from '../embeddingsCodec';
import type { HelpEmbeddingsIndex } from '../types';

const DIMENSIONS = 4;

const buildIndex = (): HelpEmbeddingsIndex => ({
  chunks: [
    {
      slug: 'guides/widget',
      title: 'Widget Guide',
      sectionPath: 'Setup > Install',
      vector: [0.5, -0.25, 0.125, 0],
      tokenCount: 42,
      accessLevel: 'public',
    },
    {
      slug: 'admin/runbook',
      title: 'Widget Runbook',
      sectionPath: 'Ops',
      vector: [0.008347, -0.048309, 0.06781, 0.000052],
      tokenCount: 7,
      accessLevel: 'admin',
    },
  ],
  model: 'text-embedding-3-small',
  dimensions: DIMENSIONS,
  generatedAt: '2026-01-01T00:00:00.000Z',
  sourceArticleCount: 2,
});

describe('help embeddings codec', () => {
  it('stores vectors out of the metadata JSON, at 4 bytes per value', () => {
    const { metadataJson, vectors } = encodeHelpEmbeddings(buildIndex());

    expect(JSON.parse(metadataJson).chunks[0]).not.toHaveProperty('vector');
    expect(vectors.length).toBe(2 * DIMENSIONS * 4);
  });

  it('round-trips metadata exactly and vectors to Float32 precision', () => {
    const index = buildIndex();
    const { metadataJson, vectors } = encodeHelpEmbeddings(index);

    const decoded = decodeHelpEmbeddings(metadataJson, vectors);

    expect(decoded.chunks.map(({ vector: _vector, ...rest }) => rest)).toEqual(
      index.chunks.map(({ vector: _vector, ...rest }) => rest)
    );
    expect(decoded.model).toBe(index.model);
    expect(decoded.dimensions).toBe(DIMENSIONS);
    decoded.chunks.forEach((chunk, chunkIndex) => {
      chunk.vector.forEach((value, valueIndex) => {
        expect(value).toBeCloseTo(index.chunks[chunkIndex].vector[valueIndex], 6);
      });
    });
  });

  it('keeps vectors in chunk order', () => {
    const { metadataJson, vectors } = encodeHelpEmbeddings(buildIndex());

    const decoded = decodeHelpEmbeddings(metadataJson, vectors);

    expect(decoded.chunks[0].vector).toEqual([0.5, -0.25, 0.125, 0]);
  });

  it('rejects a chunk whose vector length differs from the declared dimensions', () => {
    const index = buildIndex();
    index.chunks[1].vector = [1, 2, 3];

    expect(() => encodeHelpEmbeddings(index)).toThrow(/admin\/runbook.*3 dimensions, expected 4/);
  });

  it('rejects a truncated binary so retrieval falls back instead of scoring garbage', () => {
    const { metadataJson, vectors } = encodeHelpEmbeddings(buildIndex());

    expect(() => decodeHelpEmbeddings(metadataJson, vectors.subarray(0, vectors.length - 4))).toThrow(
      /bytes, expected/
    );
  });

  it('rejects an oversized binary, as left by a build with more chunks', () => {
    const { metadataJson, vectors } = encodeHelpEmbeddings(buildIndex());

    expect(() => decodeHelpEmbeddings(metadataJson, Buffer.concat([vectors, Buffer.alloc(4)]))).toThrow(
      /bytes, expected/
    );
  });

  it('rejects a binary of the right size that belongs to a different build', () => {
    const { metadataJson } = encodeHelpEmbeddings(buildIndex());
    const other = buildIndex();
    other.chunks[0].vector = [0.9, 0.9, 0.9, 0.9];

    expect(() => decodeHelpEmbeddings(metadataJson, encodeHelpEmbeddings(other).vectors)).toThrow(/checksum/);
  });

  it('rejects stale metadata from the older all-in-JSON format', () => {
    const legacyJson = JSON.stringify(buildIndex());
    const { vectors } = encodeHelpEmbeddings(buildIndex());

    expect(() => decodeHelpEmbeddings(legacyJson, vectors)).toThrow(/checksum/);
    expect(() => decodeHelpEmbeddings(legacyJson, Buffer.alloc(0))).toThrow(/bytes, expected/);
  });
});
