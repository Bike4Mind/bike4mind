import { describe, it, expect } from 'vitest';
import {
  createModalStillImageSchema,
  getModalStillImageErrors,
  getModalVideoErrors,
  isAllowedModalMediaUrl,
  MODAL_MEDIA_URL_HINT,
  ModalVideoSchema,
} from './ModalTypes';

const S3 = 'https://bucket.s3.us-east-2.amazonaws.com/modals';

describe('isAllowedModalMediaUrl', () => {
  it('accepts https on the CSP-allowed hosts', () => {
    expect(isAllowedModalMediaUrl(`${S3}/demo.mp4`)).toBe(true);
    expect(isAllowedModalMediaUrl('https://d111.cloudfront.net/demo.mp4')).toBe(true);
  });

  it.each([
    'http://bucket.s3.us-east-2.amazonaws.com/a.mp4',
    'https://cdn.example.com/a.mp4',
    'https://amazonaws.com.evil.test/a.mp4',
    // The CSP source matches port 443 only, so this could never load.
    'https://d111.cloudfront.net:8443/a.mp4',
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'not a url',
    `${S3}/${'a'.repeat(2048)}.mp4`,
  ])('rejects %s', url => {
    expect(isAllowedModalMediaUrl(url)).toBe(false);
  });
});

describe('isAllowedModalMediaUrl policy', () => {
  it('accepts an extra origin exactly, including http when the origin is http', () => {
    const policy = { extraOrigins: ['http://localhost:9000'] };
    expect(isAllowedModalMediaUrl('http://localhost:9000/fab/modals/a.mp4', policy)).toBe(true);
    expect(isAllowedModalMediaUrl('https://localhost:9000/fab/modals/a.mp4', policy)).toBe(false);
    expect(isAllowedModalMediaUrl('http://localhost:9001/fab/modals/a.mp4', policy)).toBe(false);
    expect(isAllowedModalMediaUrl('http://cdn.example.com/a.mp4', policy)).toBe(false);
  });

  it('accepts an explicitly allowed url', () => {
    const url = 'http://minio.local/fab/modals/a.mp4';
    expect(isAllowedModalMediaUrl(url, { allowedUrls: new Set([url]) })).toBe(true);
    expect(isAllowedModalMediaUrl(url)).toBe(false);
  });
});

describe('getModalVideoErrors', () => {
  it('is empty for a valid or missing video', () => {
    expect(getModalVideoErrors(null)).toEqual({});
    expect(getModalVideoErrors({ landscapeUrl: `${S3}/a.mp4`, landscapePosterUrl: `${S3}/a.png` })).toEqual({});
  });

  it('flags a disallowed host and a poster without its video', () => {
    expect(
      getModalVideoErrors({ landscapeUrl: 'https://cdn.example.com/a.mp4', portraitPosterUrl: `${S3}/p.png` })
    ).toEqual({ landscapeUrl: MODAL_MEDIA_URL_HINT, portraitPosterUrl: 'A 9:16 poster needs its 9:16 video' });
  });
});

describe('ModalVideoSchema', () => {
  it('accepts allowed urls and nulls', () => {
    const video = {
      landscapeUrl: `${S3}/demo.mp4`,
      landscapePosterUrl: null,
      portraitUrl: 'https://d111.cloudfront.net/demo-9x16.mp4',
      portraitPosterUrl: null,
    };
    expect(ModalVideoSchema.parse(video)).toEqual(video);
  });

  it('reports each problem on its field', () => {
    const result = ModalVideoSchema.safeParse({
      landscapeUrl: 'javascript:alert(1)',
      portraitPosterUrl: `${S3}/p.png`,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(i => i.path)).toEqual([['landscapeUrl'], ['portraitPosterUrl']]);
  });
});

describe('getModalStillImageErrors', () => {
  it('is empty for a valid or missing image', () => {
    expect(getModalStillImageErrors(null)).toEqual({});
    expect(getModalStillImageErrors({ landscapeUrl: `${S3}/s.png`, portraitUrl: null })).toEqual({});
  });

  it('flags a disallowed host on each field', () => {
    expect(
      getModalStillImageErrors({
        landscapeUrl: 'https://evil.example.com/s.png',
        portraitUrl: 'http://d111.cloudfront.net/t.png',
      })
    ).toEqual({ landscapeUrl: MODAL_MEDIA_URL_HINT, portraitUrl: MODAL_MEDIA_URL_HINT });
  });
});

describe('createModalStillImageSchema', () => {
  it('accepts a deployment origin and reports each problem on its field', () => {
    const schema = createModalStillImageSchema({ extraOrigins: ['http://minio.local:9000'] });
    expect(schema.safeParse({ landscapeUrl: 'http://minio.local:9000/modals/s.png' }).success).toBe(true);
    const bad = schema.safeParse({ portraitUrl: 'https://evil.example.com/t.png' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].path).toEqual(['portraitUrl']);
  });
});
