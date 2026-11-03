import { z } from 'zod';
import { LocalRuntimeError, RuntimeHttpError } from './errors';
import { DEFAULT_REQUEST_TIMEOUT_MS, requestJson } from './http';
import type { FetchLike, OllamaRegistryLayers } from './types';

export const DEFAULT_OLLAMA_REGISTRY = 'https://registry.ollama.ai';
export const OLLAMA_MODEL_LAYER = 'application/vnd.ollama.image.model';
export const REGISTRY_MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';

export const registryManifestSchema = z.object({
  layers: z.array(z.object({ mediaType: z.string(), digest: z.string() })),
});

export function registryLayers(manifest: z.infer<typeof registryManifestSchema>): OllamaRegistryLayers {
  const hex = (digest: string) => (digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest);
  const models = manifest.layers.filter(layer => layer.mediaType === OLLAMA_MODEL_LAYER);
  return {
    model: models.length === 1 ? hex(models[0].digest) : null,
    others: manifest.layers
      .filter(layer => layer.mediaType !== OLLAMA_MODEL_LAYER)
      .map(layer => ({ mediaType: layer.mediaType, digest: hex(layer.digest) })),
  };
}

export interface OllamaLibraryLayersOptions {
  fetch?: FetchLike;
  endpoint?: string;
  signal?: AbortSignal;
}

const LIBRARY_REF = /^([a-z0-9][a-z0-9._-]{0,127}):([\w][\w.-]{0,127})$/;

/** The layers the Ollama library serves for `name:tag` (what a pull of that ref fetches); null when no such tag. */
export async function ollamaLibraryLayers(
  ref: string,
  options: OllamaLibraryLayersOptions = {}
): Promise<OllamaRegistryLayers | null> {
  const match = LIBRARY_REF.exec(ref);
  if (!match) throw new LocalRuntimeError(`Invalid Ollama library ref: ${ref}`, 'ollama-registry');
  const client = {
    runtimeId: 'ollama-registry',
    baseUrl: (options.endpoint ?? DEFAULT_OLLAMA_REGISTRY).replace(/\/+$/, ''),
    fetch: options.fetch ?? fetch,
    headers: { accept: REGISTRY_MANIFEST_ACCEPT },
  };
  try {
    const manifest = await requestJson(
      client,
      `/v2/library/${match[1]}/manifests/${match[2]}`,
      registryManifestSchema,
      { signal: options.signal, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS }
    );
    return registryLayers(manifest);
  } catch (error) {
    if (error instanceof RuntimeHttpError && [400, 404].includes(error.status)) return null;
    throw error;
  }
}
