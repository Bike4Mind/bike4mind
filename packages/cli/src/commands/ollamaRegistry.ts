/**
 * Reads an Ollama registry manifest before a pull: total download size and the license texts the model ships
 * with, so `b4m models pull <name>` can show both and ask before anything downloads.
 */

import { z } from 'zod';

export const OLLAMA_REGISTRY = 'https://registry.ollama.ai';
/** Hosts a pull ref may name for Ollama's registry; `ollama.com` names resolve against the same registry. */
export const OLLAMA_REGISTRY_HOSTS: ReadonlySet<string> = new Set(['registry.ollama.ai', 'ollama.com']);

const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';
const LICENSE_LAYER = 'application/vnd.ollama.image.license';
const MAX_LICENSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const NAME_PART_RE = /^[A-Za-z0-9][\w.-]{0,127}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const manifestSchema = z.object({
  layers: z.array(
    z.object({ mediaType: z.string(), digest: z.string().regex(DIGEST_RE), size: z.number().nonnegative() })
  ),
});

export interface OllamaModelName {
  namespace: string;
  model: string;
  tag: string;
  /** The model's page on ollama.com. */
  page: string;
}

export interface OllamaManifestInfo {
  sizeBytes: number;
  /** One text per license layer; '' when a layer is too large to read. */
  licenses: string[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `[namespace/]model[:tag]`, without a registry host. */
export function parseOllamaName(name: string): OllamaModelName {
  const parts = name.split('/');
  if (parts.length > 2) throw new Error(`Not an Ollama model name: ${name}`);
  const [namespace, rest] = parts.length === 2 ? parts : ['library', parts[0]];
  const colon = rest.indexOf(':');
  const model = colon === -1 ? rest : rest.slice(0, colon);
  const tag = colon === -1 ? 'latest' : rest.slice(colon + 1);
  if (![namespace, model, tag].every(part => NAME_PART_RE.test(part)))
    throw new Error(`Not an Ollama model name: ${name}`);
  const page =
    namespace === 'library' ? `https://ollama.com/library/${model}` : `https://ollama.com/${namespace}/${model}`;
  return { namespace, model, tag, page };
}

export async function readOllamaManifest(
  name: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<OllamaManifestInfo> {
  const { namespace, model, tag } = parseOllamaName(name);
  const base = `${OLLAMA_REGISTRY}/v2/${namespace}/${model}`;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await fetchImpl(`${base}/manifests/${tag}`, {
    headers: { accept: MANIFEST_ACCEPT },
    signal: requestSignal,
  });
  if (response.status === 404) throw new Error(`The Ollama registry has no model named ${name}.`);
  if (!response.ok) throw new Error(`The Ollama registry answered ${response.status} for ${name}.`);
  const parsed = manifestSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`The Ollama registry sent an unreadable manifest for ${name}.`);
  const { layers } = parsed.data;
  const licenses = await Promise.all(
    layers
      .filter(layer => layer.mediaType === LICENSE_LAYER)
      .map(async layer => {
        if (layer.size > MAX_LICENSE_BYTES) return '';
        const blob = await fetchImpl(`${base}/blobs/${layer.digest}`, { signal: requestSignal });
        if (!blob.ok) throw new Error(`The Ollama registry answered ${blob.status} for ${name}'s license.`);
        return (await blob.text()).slice(0, MAX_LICENSE_BYTES);
      })
  );
  return { sizeBytes: layers.reduce((sum, layer) => sum + layer.size, 0), licenses };
}

// Recognizes the standard Apache-2.0, MIT and BSD texts only; anything else, or any of these mixed with
// extra use terms, counts as restricted.
const PERMISSIVE_TEXTS = [
  /Apache License\s+Version 2\.0, January 2004/i,
  /Permission is hereby granted, free of charge, to any person obtaining a copy/i,
  /Redistribution and use in source and binary forms, with or without\s+modification, are permitted/i,
];
const RESTRICTIVE_TERMS =
  /acceptable use|community license|non-?commercial|prohibited use|use restrictions|responsible ai|\brail\b|terms of use/i;

export function classifyLicenses(texts: string[]): { title: string; permissive: boolean } {
  const titles = texts.map(text => {
    const first = text
      .split('\n')
      .map(line => line.replace(/^[\s#*=-]+|[\s#*=-]+$/g, ''))
      .find(Boolean);
    return first ? first.slice(0, 80) : 'license text not shown';
  });
  const permissive =
    texts.length > 0 &&
    texts.every(text => PERMISSIVE_TEXTS.some(re => re.test(text)) && !RESTRICTIVE_TERMS.test(text));
  return { title: titles.length > 0 ? titles.join(' + ') : 'none declared', permissive };
}
