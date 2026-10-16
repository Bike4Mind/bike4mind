/**
 * The slug a NEW publication of an artifact gets when the caller doesn't pin one. Shared by every
 * publisher (web Share dialog, CLI MCP `publish_artifact`) so the same artifact always derives the
 * same slug wherever it is published from.
 */

const SLUG_TITLE_MAX = 48;
const ARTIFACT_HASH_LENGTH = 8;

export function slugifyArtifactTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_TITLE_MAX)
    .replace(/-+$/, '');
}

/**
 * `{slugified title}-{first 8 hex of sha256(artifactId)}`. Hashed rather than sliced because every
 * artifact id shares the `artifact_` prefix, so a prefix slice collides for same-titled artifacts,
 * and finalize upserts on tier+scopeId+slug, so a collision overwrites the other artifact's page.
 * Web Crypto rather than node:crypto because the client bundles this module too.
 */
export async function deriveArtifactPublishSlug(title: string, artifactId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifactId));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, ARTIFACT_HASH_LENGTH);
  return `${slugifyArtifactTitle(title) || 'artifact'}-${hash}`;
}
