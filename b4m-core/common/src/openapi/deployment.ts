import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import type { EndpointContract } from '../api-contract/types';
import { buildOpenApiDocument } from './document';
import { registerContracts } from './operations';

// Must match the sidecar name apps/client/scripts/generate-premium-glue.mjs writes.
export const CONTRACT_SOURCES_FILE = 'premiumContractSources.generated.json';

/**
 * The spec for one deployment: core CONTRACTS (registered when ./operations loads)
 * plus the contracts the add-on packages mounted on that deployment contribute.
 * Returns null when there are none, so the caller serves the committed core spec
 * instead of a regenerated copy of it.
 *
 * Registers into the module-global registry, so call it at most once per process.
 */
export function buildDeploymentOpenApiDocument(
  version: string,
  extraContracts: readonly EndpointContract[]
): Record<string, unknown> | null {
  if (extraContracts.length === 0) return null;
  registerContracts(extraContracts);
  const doc = buildOpenApiDocument(version);

  // document.ts declares only the core tag set; a tag an operation uses but the
  // document never declares is undocumented, so declare the missing ones.
  const tags = (doc.tags ?? []) as { name: string }[];
  const declared = new Set(tags.map(t => t.name));
  for (const tag of extraContracts.flatMap(c => c.tags ?? [])) {
    if (declared.has(tag)) continue;
    declared.add(tag);
    tags.push({ name: tag });
  }
  doc.tags = tags;
  return doc;
}

/**
 * Load the add-on contract list the premium glue codegen emits. A missing file (an
 * install-only checkout, or no add-on declares contractsExport) means none.
 */
export async function loadDeploymentContracts(contractsPath: string): Promise<readonly EndpointContract[]> {
  if (!existsSync(contractsPath)) return [];
  // The list loads as CommonJS (apps/client is not an ES module package), so add-on
  // schemas come from zod's CJS build, a separate class hierarchy from the ESM one
  // registry.ts extends. Unextended, registering them fails on `.openapi()`. Extend the
  // zod each add-on resolves from its own directory - an add-on can resolve a different
  // copy than core - and do it before the import, since zod only patches schemas built
  // after the extension.
  for (const source of readContractSources(contractsPath)) {
    extendZodWithOpenApi(createRequire(resolve(dirname(contractsPath), source))('zod'));
  }
  const mod = (await import(pathToFileURL(contractsPath).href)) as { premiumContracts?: unknown };
  // Throw rather than fall back to []: an empty list silently serves the core-only spec.
  if (!Array.isArray(mod.premiumContracts)) {
    throw new Error(`[openapi] ${contractsPath} does not export a premiumContracts array`);
  }
  return mod.premiumContracts as readonly EndpointContract[];
}

/** The contributor module paths generate-premium-glue.mjs writes beside the list. */
function readContractSources(contractsPath: string): readonly string[] {
  const sourcesPath = resolve(dirname(contractsPath), CONTRACT_SOURCES_FILE);
  if (!existsSync(sourcesPath)) {
    throw new Error(`[openapi] ${sourcesPath} is missing - rerun the premium glue codegen`);
  }
  const sources: unknown = JSON.parse(readFileSync(sourcesPath, 'utf8'));
  if (!Array.isArray(sources) || !sources.every(source => typeof source === 'string')) {
    throw new Error(`[openapi] ${sourcesPath} is not an array of module paths`);
  }
  return sources;
}
