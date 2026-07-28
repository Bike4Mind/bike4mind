import { ModelBackend, type ModelRecord } from '@bike4mind/common';
import type {
  DiscoveredModel,
  DiscoveryCredentials,
  DiscoveryFetchContext,
  DiscoverySource,
  SourceResult,
} from '../types';
import { compact, fetchJson } from './http';

export const BFL_OPENAPI_URL = 'https://api.bfl.ai/openapi.json';

/**
 * BFL publishes no model list. Its unauthenticated OpenAPI document IS the
 * catalog: one POST path per model, and the request schema of that path is the
 * option list. Diffing it is how a retired `flux-pro` 1.0 stops being offered
 * and how the FLUX.2 family starts being offered, neither of which the
 * hardcoded adapter table has managed on its own.
 *
 * It emits no `name`. BFL publishes only the endpoint slug, and the catalog's
 * FLUX names are curated ("FLUX Pro Ultra", "FLUX Pro (Legacy)") - overwriting
 * those with `flux-pro-1-1-ultra` would be a presentation regression dressed up
 * as discovery. The cost is stated: a FLUX endpoint the catalog has never held
 * is discovered and then DROPPED for a missing name, which surfaces in the run's
 * dropped records as an operator work item rather than as silence.
 */
interface OpenApiSchema {
  properties?: Record<string, unknown>;
  $ref?: unknown;
}

interface OpenApiOperation {
  requestBody?: { content?: Record<string, { schema?: OpenApiSchema }> };
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, OpenApiOperation> | undefined>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

/** Properties that mean the model takes an image alongside the prompt. */
const IMAGE_INPUT_PROPERTIES = ['image_prompt', 'input_image', 'image', 'person', 'garment'];

const SCHEMA_REF_PREFIX = '#/components/schemas/';

function resolveSchema(schema: OpenApiSchema | undefined, document: OpenApiDocument): OpenApiSchema | undefined {
  const ref = schema?.$ref;
  if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_REF_PREFIX)) return schema;
  return document.components?.schemas?.[ref.slice(SCHEMA_REF_PREFIX.length)];
}

function requestProperties(operation: OpenApiOperation | undefined, document: OpenApiDocument): string[] {
  const schema = operation?.requestBody?.content?.['application/json']?.schema;
  const resolved = resolveSchema(schema, document);
  return Object.keys(resolved?.properties ?? {});
}

export function normalizeBflOpenApi(payload: unknown): DiscoveredModel[] {
  const document = (payload ?? {}) as OpenApiDocument;
  const records: DiscoveredModel[] = [];

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    const properties = requestProperties(operations?.post, document);
    // A POST that takes a prompt is a model; everything else on this host is
    // account plumbing (credits, finetune management, result polling) or an
    // image tool with no prompt to drive it from.
    if (!properties.includes('prompt')) continue;

    const id = path.replace(/^\/v1\//, '');
    if (!id || id === path) continue;

    records.push({
      modelId: id,
      patch: compact<Partial<ModelRecord>>({
        id,
        vendor: 'bfl',
        backend: ModelBackend.BFL,
        type: 'image',
        // Image models have no token context; 0 is the catalog's "not applicable".
        contextWindow: 0,
        supportsImageVariation: IMAGE_INPUT_PROPERTIES.some(property => properties.includes(property)),
        supportsSafetyTolerance: properties.includes('safety_tolerance'),
      }),
    });
  }

  return records.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export function createBflSource(): DiscoverySource {
  return {
    name: 'bfl',
    kind: 'provider',
    // openapi.json needs no auth, but a deployment with no BFL key cannot call
    // any of these models, so listing them would only offer choices that fail.
    isConfigured: (creds: DiscoveryCredentials) => Boolean(creds.bfl),
    async fetch(ctx: DiscoveryFetchContext): Promise<SourceResult> {
      const response = await fetchJson<OpenApiDocument>({ url: BFL_OPENAPI_URL }, ctx);
      if (!response.ok) return { ok: false, error: response.error, httpStatus: response.status };
      if (response.notModified) return { ok: false, error: 'unexpected 304 from a provider list' };

      const records = normalizeBflOpenApi(response.body);
      // A document that parses but names no prompt-taking path is a schema
      // restructure, not BFL retiring FLUX.
      if (records.length === 0) {
        return { ok: false, error: 'openapi.json exposed no prompt-taking paths', httpStatus: response.status };
      }

      return { ok: true, records, authoritativeFor: [ModelBackend.BFL], httpStatus: response.status };
    },
  };
}
