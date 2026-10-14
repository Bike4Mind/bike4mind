import { describe, expect, it } from 'vitest';
import { videoGenerationKeys } from './videoGenerationKeys';

// Pins each entry to its literal: if one changes shape, cached data silently detaches from its invalidations
// (the websocket listener and the list seed both write by these keys).
describe('videoGenerationKeys', () => {
  it('nests every key under the all prefix', () => {
    expect(videoGenerationKeys.all).toEqual(['videoGenerations']);
    expect(videoGenerationKeys.models).toEqual(['videoGenerations', 'models']);
    expect(videoGenerationKeys.list).toEqual(['videoGenerations', 'list']);
    expect(videoGenerationKeys.details).toEqual(['videoGenerations', 'detail']);
    expect(videoGenerationKeys.detail('job-1')).toEqual(['videoGenerations', 'detail', 'job-1']);
  });

  it('keeps details a prefix of every detail key', () => {
    expect(videoGenerationKeys.detail('job-1').slice(0, 2)).toEqual([...videoGenerationKeys.details]);
  });
});
