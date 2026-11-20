import { describe, expect, it } from 'vitest';
import { toPublicLineage } from './toPublicLineage';
import type { FileLineage } from './fileLineage';

const FILE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PARENT = 'bbbbbbbbbbbbbbbbbbbbbbbb';

describe('toPublicLineage', () => {
  const lineage: FileLineage = {
    fileId: FILE,
    ancestors: [
      {
        fileId: FILE,
        depth: 0,
        redacted: false,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        generator: 'video',
        modelId: 'veo-3',
        prompt: 'a fox',
        url: 'https://cdn/clip',
        createdAt: '2026-01-01T00:00:00.000Z',
        request: { aspectRatio: '16:9' },
      },
      { fileId: PARENT, depth: 1, redacted: true },
    ],
    children: [],
    edges: [{ parentId: PARENT, childId: FILE, role: 'first_frame' }],
    truncated: false,
  };

  it('maps to snake_case and keeps the edge role', () => {
    const result = toPublicLineage(lineage);
    expect(result.file_id).toBe(FILE);
    expect(result.ancestors[0]).toMatchObject({
      file_name: 'clip.mp4',
      download_url: 'https://cdn/clip',
      redacted: false,
    });
    expect(result.edges).toEqual([{ parent_id: PARENT, child_id: FILE, role: 'first_frame' }]);
  });

  it('reveals nothing but id and depth for a redacted ancestor', () => {
    const redacted = toPublicLineage(lineage).ancestors[1];
    expect(redacted).toEqual({
      file_id: PARENT,
      depth: 1,
      redacted: true,
      file_name: null,
      mime_type: null,
      generator: null,
      model_id: null,
      prompt: null,
      download_url: null,
      created_at: null,
      request: null,
    });
  });
});
