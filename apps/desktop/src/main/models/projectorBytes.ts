import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HubManifest } from '@bike4mind/common';
import type { ModelContents } from '@bike4mind/local-models';

/** Projector sizes by blob digest, from the curated list's pinned layers. */
export function pinnedProjectorSizes(manifest: HubManifest): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const entry of manifest.entries)
    for (const build of entry.builds) {
      const layers = build.ollama && build.ollama.kind !== 'create' ? build.ollama.layers : undefined;
      if (layers?.projector && layers.projectorBytes) sizes.set(layers.projector, layers.projectorBytes);
    }
  return sizes;
}

async function blobBytes(storeDir: string | null | undefined, digest: string): Promise<number | undefined> {
  if (!storeDir) return undefined;
  return stat(join(storeDir, 'blobs', `sha256-${digest}`)).then(
    info => info.size,
    () => undefined
  );
}

/**
 * The projector part of an installed Ollama model's listed size, so the fit estimate can count its compute buffer.
 * On this computer it is read from the model folder, then looked up in `pinned` when that read misses (a daemon in a
 * container lists paths that only exist inside it); a saved server's is only looked up in `pinned`. 0 when it has no
 * projector or any projector's size is unknown, which leaves it counted as weights.
 */
export async function installedProjectorBytes(
  contents: Pick<ModelContents, 'projectorBlobs' | 'storeDir'> | undefined,
  { pinned, onThisComputer }: { pinned?: ReadonlyMap<string, number>; onThisComputer: boolean }
): Promise<number> {
  let total = 0;
  for (const digest of contents?.projectorBlobs ?? []) {
    const read = digest && onThisComputer ? await blobBytes(contents?.storeDir, digest) : undefined;
    const size = digest ? (read ?? pinned?.get(digest)) : undefined;
    if (!size) return 0;
    total += size;
  }
  return total;
}
