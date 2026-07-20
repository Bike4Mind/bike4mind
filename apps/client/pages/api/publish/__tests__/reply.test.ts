import { describe, it, expect, vi } from 'vitest';

// reply.ts wires an Express-style handler at module load and imports server-only deps; stub them
// so we can import the pure deriveTitle helper in isolation. parseArtifactsWithFallback is NOT
// mocked - deriveTitle relies on its real artifact extraction.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, { use: () => chain, post: () => chain });
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({ Quest: {}, PublishedArtifact: {} }));
vi.mock('@server/services/publish', () => ({
  resolveVisibility: () => ({}),
  checkScopePermission: () => ({}),
  checkPublishQuota: () => ({}),
}));

import { deriveTitle } from '../reply';

describe('deriveTitle', () => {
  it('uses the first prose line, stripped of markdown heading markers', () => {
    expect(deriveTitle('# Hello world\n\nmore text')).toBe('Hello world');
  });

  it('prefers prose over a leading artifact block', () => {
    expect(deriveTitle('Intro line\n<artifact type="text/html" title="Tip">y</artifact>')).toBe('Intro line');
  });

  it('falls back to the artifact title when the reply is nothing but an artifact', () => {
    expect(deriveTitle('<artifact type="text/html" title="Tip Calculator">...</artifact>')).toBe('Tip Calculator');
  });

  it('falls back to "Shared reply" when there is no prose and no usable artifact title', () => {
    // No title attribute -> parser assigns "Untitled Artifact", which deriveTitle skips.
    expect(deriveTitle('<artifact type="text/html">y</artifact>')).toBe('Shared reply');
  });

  it('never returns the raw <artifact> wrapper tag as the title (#708)', () => {
    const title = deriveTitle('<artifact type="text/html" title="Real Title"><label>x</label></artifact>');
    expect(title).not.toContain('<artifact');
    expect(title).toBe('Real Title');
  });
});
