import { describe, expect, it } from 'vitest';
import { createModalVideoSchema } from '../types/entities/ModalTypes';
import {
  fromPublicReleaseNoteImage,
  PublicReleaseNoteSchema,
  ReleaseNoteMediaParamsSchema,
  ReleaseNoteSchema,
  releaseNoteMediaUrl,
  toPublicReleaseNoteImage,
} from './releaseNotes';

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
    const video = { landscape_url: 'https://self-host.example/wide.mp4' };
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

describe('release note image', () => {
  const stored = {
    releaseTag: 'v1',
    deployedSha: 'abc',
    deployedAt: '2026-01-01T00:00:00.000Z',
    headline: 'h',
    summary: 's',
    items: [],
    audience: 'public',
    status: 'scheduled',
    publishAt: '2026-01-01T12:00:00.000Z',
    editedAt: null,
    schemaVersion: 1,
  };

  it('is optional and nullable on the public and the stored note', () => {
    expect(PublicReleaseNoteSchema.safeParse(publicNote).success).toBe(true);
    expect(PublicReleaseNoteSchema.safeParse({ ...publicNote, image: null }).success).toBe(true);
    const image = {
      landscape_url: 'https://self-host.example/wide.png',
      portrait_url: 'https://self-host.example/t.png',
    };
    expect(PublicReleaseNoteSchema.parse({ ...publicNote, image }).image).toEqual(image);
    expect(ReleaseNoteSchema.safeParse(stored).success).toBe(true);
    expect(ReleaseNoteSchema.safeParse({ ...stored, image: null }).success).toBe(true);
    expect(ReleaseNoteSchema.safeParse({ ...stored, image: { landscapeUrl: 'a', portraitUrl: 'b' } }).success).toBe(
      true
    );
  });

  it('maps between the stored and the public shape', () => {
    expect(toPublicReleaseNoteImage({ landscapeUrl: 'a' })).toEqual({ landscape_url: 'a', portrait_url: null });
    expect(fromPublicReleaseNoteImage({ portrait_url: 'b' })).toEqual({ landscapeUrl: null, portraitUrl: 'b' });
  });

  it('accepts the image assets on the media route beside the video ones', () => {
    for (const asset of [
      'landscape',
      'landscape-poster',
      'portrait',
      'portrait-poster',
      'image-landscape',
      'image-portrait',
    ]) {
      expect(ReleaseNoteMediaParamsSchema.safeParse({ id: 'n1', asset }).success).toBe(true);
    }
    expect(ReleaseNoteMediaParamsSchema.safeParse({ id: 'n1', asset: 'image' }).success).toBe(false);
  });

  it('reads an image asset from the image and a video asset from the video', () => {
    const note = { video: { landscapeUrl: 'v' }, image: { landscapeUrl: 'i', portraitUrl: null } };
    expect(releaseNoteMediaUrl(note, 'landscape')).toBe('v');
    expect(releaseNoteMediaUrl(note, 'image-landscape')).toBe('i');
    expect(releaseNoteMediaUrl(note, 'image-portrait')).toBeNull();
    expect(releaseNoteMediaUrl({ video: null }, 'image-landscape')).toBeNull();
  });
});
