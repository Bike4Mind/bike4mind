import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveArtifactPublishSlug, slugifyArtifactTitle } from './artifactPublishSlug';

describe('deriveArtifactPublishSlug', () => {
  it('suffixes the slugified title with the first 8 hex chars of sha256(artifactId)', async () => {
    const expected = createHash('sha256').update('artifact_abc').digest('hex').slice(0, 8);
    await expect(deriveArtifactPublishSlug('My Chart!', 'artifact_abc')).resolves.toBe(`my-chart-${expected}`);
  });

  it('gives same-titled artifacts different slugs despite the shared id prefix', async () => {
    const a = await deriveArtifactPublishSlug('Chronosphere', 'artifact_1111');
    const b = await deriveArtifactPublishSlug('Chronosphere', 'artifact_2222');
    expect(a).not.toBe(b);
  });

  it('is stable for the same artifact', async () => {
    const first = await deriveArtifactPublishSlug('Chronosphere', 'artifact_1111');
    await expect(deriveArtifactPublishSlug('Chronosphere', 'artifact_1111')).resolves.toBe(first);
  });

  it('falls back to "artifact" when the title has no slug characters', async () => {
    await expect(deriveArtifactPublishSlug('!!!', 'artifact_1111')).resolves.toMatch(/^artifact-[0-9a-f]{8}$/);
  });
});

describe('slugifyArtifactTitle', () => {
  it('caps at 48 chars without leaving a trailing hyphen', () => {
    const slug = slugifyArtifactTitle(`${'a'.repeat(47)} tail`);
    expect(slug).toBe('a'.repeat(47));
  });
});
