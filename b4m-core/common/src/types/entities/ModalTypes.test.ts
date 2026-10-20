import { describe, it, expect } from 'vitest';
import { ModalVideoSchema } from './ModalTypes';

describe('ModalVideoSchema', () => {
  it('accepts http(s) urls and nulls', () => {
    const video = {
      landscapeUrl: 'https://bucket.s3.us-east-2.amazonaws.com/modals/demo.mp4',
      landscapePosterUrl: null,
      portraitUrl: 'http://localhost:9000/modals/demo-9x16.mp4',
      portraitPosterUrl: null,
    };
    expect(ModalVideoSchema.parse(video)).toEqual(video);
  });

  it('accepts a partial object', () => {
    expect(ModalVideoSchema.parse({ portraitUrl: 'https://cdn.example.com/a.mp4' })).toEqual({
      portraitUrl: 'https://cdn.example.com/a.mp4',
    });
  });

  it.each(['javascript:alert(1)', 'data:video/mp4;base64,AAAA', 'not a url'])('rejects %s', url => {
    expect(ModalVideoSchema.safeParse({ landscapeUrl: url }).success).toBe(false);
  });
});
