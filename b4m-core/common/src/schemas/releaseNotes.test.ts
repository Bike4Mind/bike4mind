import { describe, expect, it } from 'vitest';
import { createModalVideoSchema } from '../types/entities/ModalTypes';
import { PublicReleaseNoteSchema, ReleaseNoteSchema } from './releaseNotes';

const publicNote = {
  id: 'n1',
  release_tag: 'v1',
  headline: 'h',
  summary: 's',
  published_at: '2026-01-01T00:00:00.000Z',
  items: [],
};

describe('release note video', () => {
  it('is optional and nullable on the public note, so older feeds still parse', () => {
    expect(PublicReleaseNoteSchema.safeParse(publicNote).success).toBe(true);
    expect(PublicReleaseNoteSchema.safeParse({ ...publicNote, video: null }).success).toBe(true);
    const video = { landscapeUrl: 'https://self-host.example/wide.mp4' };
    expect(PublicReleaseNoteSchema.parse({ ...publicNote, video }).video).toEqual(video);
  });

  it('is optional and nullable on the stored note', () => {
    const stored = {
      releaseTag: 'v1',
      deployedSha: 'abc',
      deployedAt: '2026-01-01',
      headline: '',
      summary: '',
      items: [],
      audience: 'public',
      status: 'scheduled',
      publishAt: '2026-01-01',
      editedAt: null,
      schemaVersion: 1,
    };
    expect(ReleaseNoteSchema.safeParse(stored).success).toBe(true);
    expect(ReleaseNoteSchema.safeParse({ ...stored, video: null }).success).toBe(true);
  });

  it('refuses a bad host on write and accepts a deployment origin', () => {
    const bad = { landscapeUrl: 'https://evil.example.com/wide.mp4' };
    expect(createModalVideoSchema().safeParse(bad).success).toBe(false);
    expect(createModalVideoSchema({ extraOrigins: ['https://evil.example.com'] }).safeParse(bad).success).toBe(true);
    expect(createModalVideoSchema().nullable().safeParse(null).success).toBe(true);
  });
});
