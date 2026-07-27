import {
  MODEL_ID_ALIASES,
  adminSettingsRepository,
  apiKeyRepository,
  cacheRepository,
  modelCatalogRepository,
  modelDiscoveryRunRepository,
  modelDiscoveryStateRepository,
} from '@bike4mind/database';
import { getSettingsByNames } from '@bike4mind/utils';
import { resolveCatalogRecords, resolveDispatchForRecord } from '@bike4mind/llm-adapters';
import { modelDiscoveryService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { createBedrockControlPlane } from './bedrockControlPlane';

type ModelDiscoveryAdapters = modelDiscoveryService.ModelDiscoveryAdapters;
type DiscoveryEnv = modelDiscoveryService.DiscoveryEnv;
type JoinTarget = modelDiscoveryService.JoinTarget;

/** One catalog read per run, shared by the Bedrock and aggregator sources. */
interface CatalogView {
  /** Every id the catalog holds - the universe an aggregator may patch (sec 5.5). */
  targets: JoinTarget[];
  /** Ids already 'active', so Bedrock skips their per-model availability call. */
  activeModelIds: Set<string>;
}

const EMPTY_VIEW: CatalogView = { targets: [], activeModelIds: new Set() };

/**
 * The catalog as the join and the Bedrock fan-out need to see it.
 *
 * Read through `resolveCatalogRecords` rather than off the raw rows so this
 * sees the same per-field-group precedence the runtime read path applies: an
 * operator row that retires a model must not leave it in the "active, skip the
 * availability check" set because a discovery row underneath still says active.
 *
 * A failed read degrades to an empty view, which costs coverage (every id
 * unmatched, every Bedrock model probed) rather than correctness.
 */
function readCatalogView(logger: Logger): () => Promise<CatalogView> {
  // Memoized for the life of one adapters object, i.e. one run: three sources
  // ask for this and none of them should trigger its own aggregation.
  let pending: Promise<CatalogView> | null = null;

  const load = async (): Promise<CatalogView> => {
    try {
      const resolved = resolveCatalogRecords(await modelCatalogRepository.rowsInForce());
      const targets: JoinTarget[] = [];
      const activeModelIds = new Set<string>();
      for (const { modelId, record } of resolved.values()) {
        const backend = record.backend;
        targets.push({ modelId, backend: typeof backend === 'string' ? backend : undefined });
        const lifecycle = record.lifecycle as { status?: string } | undefined;
        if (lifecycle?.status === 'active') activeModelIds.add(modelId);
      }
      return { targets, activeModelIds };
    } catch (error) {
      logger.warn(
        `[model-discovery] catalog read failed; joining against nothing this run: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return EMPTY_VIEW;
    }
  };

  return () => (pending ??= load());
}

/**
 * Every source, unconditionally. `isConfigured` is what gates a source per run
 * (no key, no egress, IAM-less self-host), so the registry itself is static
 * data and a source is never silently absent because of how a driver was wired.
 */
function buildSources(logger: Logger): ModelDiscoveryAdapters['sources'] {
  const catalogView = readCatalogView(logger);
  const targets = async () => (await catalogView()).targets;

  return [
    modelDiscoveryService.createOpenAiSource(),
    modelDiscoveryService.createAnthropicSource(),
    modelDiscoveryService.createXaiSource(),
    modelDiscoveryService.createGeminiSource(),
    modelDiscoveryService.createOllamaSource(),
    modelDiscoveryService.createBflSource(),
    modelDiscoveryService.createElevenLabsSource(),
    modelDiscoveryService.createBedrockSource({
      // A thunk: the SDK client is built when the source runs, so a deployment
      // whose credentials never reach Bedrock pays nothing for the wiring.
      client: () => createBedrockControlPlane(),
      activeModelIds: async () => (await catalogView()).activeModelIds,
    }),
    modelDiscoveryService.createModelsDevSource({ targets, aliases: MODEL_ID_ALIASES }),
    modelDiscoveryService.createLiteLlmSource({ targets, aliases: MODEL_ID_ALIASES }),
  ];
}

/**
 * A linked SST secret, read by name. Two of these (OPENAI_API_KEY,
 * XAI_API_KEY) are new in infra/secrets.ts and the generated sst-env.d.ts only
 * learns about them on the next deploy, so a compile-time `Resource.X` access
 * would break the build on a fresh checkout. Indexing a Record view keeps
 * secrets linked rather than copied into the lambda environment, which is the
 * repo's convention, without depending on the generated declaration. Any
 * unlinked or unregistered name degrades to undefined ("not configured").
 */
function linkedSecret(name: string): string | undefined {
  try {
    return (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
  } catch {
    return undefined;
  }
}

/**
 * Provider keys for a run. SST secrets arrive as linked Resources, not as
 * process.env, so a hosted deployment's keys would be invisible to
 * getDiscoveryCredentials without this bridge. process.env wins where it is
 * set, which is the self-host tier (.env.selfhost) reading exactly as before.
 */
export function discoveryEnv(): DiscoveryEnv {
  return Object.freeze({
    ...process.env,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? linkedSecret('OPENAI_API_KEY'),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? linkedSecret('ANTHROPIC_API_KEY'),
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? linkedSecret('GEMINI_API_KEY'),
    XAI_API_KEY: process.env.XAI_API_KEY ?? linkedSecret('XAI_API_KEY'),
  });
}

/**
 * The one wiring both drivers use, so "the cron and the worker run the same
 * thing" is true by construction rather than by review. Everything
 * deployment-specific (which repositories, which credentials, which env, which
 * AWS client) is decided here; the service itself takes no globals.
 *
 * Call it once per run: the source registry it builds carries a memoized
 * catalog read, and reusing an adapters object across runs would reuse that
 * snapshot too.
 */
export function buildModelDiscoveryAdapters(logger: Logger): ModelDiscoveryAdapters {
  const env = discoveryEnv();
  return {
    db: {
      catalog: modelCatalogRepository,
      discoveryState: modelDiscoveryStateRepository,
      discoveryRuns: modelDiscoveryRunRepository,
      cache: cacheRepository,
      adminSettings: adminSettingsRepository,
    },
    sources: buildSources(logger),
    resolveCredentials: () =>
      modelDiscoveryService.getDiscoveryCredentials(
        { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
        env
      ),
    // Seed-side derivation of the dispatch group: without it a newly discovered
    // model has no adapterFamily and stays metadata-only forever.
    resolveDispatch: resolveDispatchForRecord,
    logger,
    env,
  };
}
