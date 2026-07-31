import {
  CATALOG_SCHEMA_VERSION,
  ModelBackend,
  ModelCatalogRowInput,
  settingsMap,
  type IModelCatalogReadResult,
  type IModelCatalogRow,
  type IModelCatalogRowDocument,
  type IModelCatalogRowInput,
  ModelPriceInput,
  type IModelDiscoveryRun,
  type IModelDiscoveryRunDocument,
  type IModelDiscoveryState,
  type IModelPrice,
  type IModelPriceDocument,
  type IModelPriceInput,
  type ModelLifecycleSuggestionInput,
  type ModelRecord,
  type SettingKey,
  type SettingValue,
} from '@bike4mind/common';
import type { DiscoveredModel, DiscoveryCredentials, DiscoverySource, SourceResult } from '../types';

/**
 * In-memory stand-ins for the repositories runModelDiscovery is injected with.
 * The service layer cannot import @bike4mind/database, so these mirror the
 * behaviors the run depends on - claimDedup's expiry-only lease, the catalog's
 * unique-index skip, and rowsInForce's per-(modelId, source) collapse - closely
 * enough that a change in those semantics breaks a test here.
 */
export class FakeCacheRepository {
  readonly entries = new Map<string, { result: Record<string, unknown>; expiresAt: Date }>();
  deleteCalls = 0;
  now: () => Date = () => new Date();

  async claimDedup(key: string, data: Record<string, unknown>, ttlMs: number) {
    const at = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > at) {
      return { claimed: false, existingData: existing.result };
    }
    this.entries.set(key, { result: data, expiresAt: new Date(at.getTime() + ttlMs) });
    return { claimed: true };
  }

  /** Enough of ICacheDocument for the fenced release to read its own token back. */
  async findByKey(key: string) {
    const entry = this.entries.get(key);
    return entry ? { key, result: entry.result, expiresAt: entry.expiresAt } : null;
  }

  async deleteByKey(key: string): Promise<void> {
    this.deleteCalls += 1;
    this.entries.delete(key);
  }
}

export class FakeCatalogRepository {
  readonly rows: IModelCatalogRow[] = [];

  async append(row: IModelCatalogRowInput): Promise<IModelCatalogRowDocument | null> {
    const parsed = ModelCatalogRowInput.parse(row);
    const collides = this.rows.some(
      existing =>
        existing.modelId === parsed.modelId && existing.effectiveFrom.getTime() === parsed.effectiveFrom.getTime()
    );
    if (collides) return null;
    const stored = { ...parsed, schemaVersion: CATALOG_SCHEMA_VERSION } as unknown as IModelCatalogRow;
    this.rows.push(stored);
    return stored as IModelCatalogRowDocument;
  }

  async rowsInForceWithRejects(at: Date = new Date()): Promise<IModelCatalogReadResult> {
    const eligible = this.rows.filter(row => row.effectiveFrom <= at);
    const newestPerKey = new Map<string, IModelCatalogRow>();
    const operator: IModelCatalogRow[] = [];
    for (const row of eligible) {
      if (row.source === 'operator') {
        operator.push(row);
        continue;
      }
      const key = `${row.modelId} ${row.source}`;
      const incumbent = newestPerKey.get(key);
      if (!incumbent || row.effectiveFrom > incumbent.effectiveFrom) newestPerKey.set(key, row);
    }
    const rows = [...newestPerKey.values(), ...operator].sort(
      (a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || a.modelId.localeCompare(b.modelId)
    );
    return { rows, rejected: 0, rejectedModelIds: [] };
  }
}

export class FakePriceRepository {
  readonly rows: IModelPrice[] = [];

  async append(row: IModelPriceInput): Promise<IModelPriceDocument | null> {
    const parsed = ModelPriceInput.parse(row);
    // Both refusals mirror ModelPriceRepository.append: a test must not be able
    // to pass against a row the collection would reject.
    if (Object.keys(parsed.pricing).length === 0) {
      throw new Error(`ModelPrice.append rejected ${parsed.modelId}: empty pricing map would settle calls free`);
    }
    if (!Object.values(parsed.pricing).some(tier => tier.input > 0 || tier.output > 0)) {
      throw new Error(`ModelPrice.append rejected ${parsed.modelId}: all-zero pricing would settle calls free`);
    }
    const collides = this.rows.some(
      existing =>
        existing.modelId === parsed.modelId &&
        existing.unit === parsed.unit &&
        existing.effectiveFrom.getTime() === parsed.effectiveFrom.getTime()
    );
    // Unlike the catalog, the price collection has no null-return path: its
    // unique index surfaces as a thrown E11000, which is what the runner has
    // to treat as a skip rather than a failed run.
    if (collides) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
    const stored = { ...parsed, createdAt: new Date(), updatedAt: new Date() } as IModelPrice;
    this.rows.push(stored);
    return stored as IModelPriceDocument;
  }

  async rowsInForce(at: Date = new Date()): Promise<IModelPrice[]> {
    const newest = new Map<string, IModelPrice>();
    for (const row of this.rows) {
      if (row.effectiveFrom > at) continue;
      const key = `${row.modelId} ${row.unit}`;
      const incumbent = newest.get(key);
      if (!incumbent || row.effectiveFrom > incumbent.effectiveFrom) newest.set(key, row);
    }
    return [...newest.values()];
  }
}

/** The join targets a driver hands its aggregators, plus the runner's invalidation hook. */
export interface FakeCatalogView {
  targets: () => Promise<string[]>;
  refresh: () => void;
  /** Reads performed, for the one-read-per-pass property. */
  reads: () => number;
}

/**
 * The drivers' memoized catalog view (apps/client/server/modelDiscovery/adapters.ts)
 * in miniature: every source that asks within one pass shares a single read, and
 * refreshCatalogView drops the memo so the next convergence pass joins against
 * the rows the previous one appended.
 */
export function fakeCatalogView(catalog: FakeCatalogRepository): FakeCatalogView {
  let pending: Promise<string[]> | null = null;
  let reads = 0;
  const load = async (): Promise<string[]> => {
    reads += 1;
    // Read at the end of time, because the driver reads at wall clock: always
    // past the instants a run stamps its own rows with.
    const { rows } = await catalog.rowsInForceWithRejects(new Date(8_640_000_000_000_000));
    return rows.map(row => row.modelId);
  };
  return {
    targets: () => (pending ??= load()),
    refresh: () => {
      pending = null;
    },
    reads: () => reads,
  };
}

/**
 * Mirrors the streak semantics the graduation predicate depends on: a miss
 * increments and stamps the start of the streak once, a sighting clears both. A
 * fake that only counted calls would let a broken K-of-48h rule pass here.
 */
export class FakeDiscoveryStateRepository {
  readonly sightings: string[] = [];
  readonly misses: string[] = [];
  readonly states = new Map<string, IModelDiscoveryState>();
  readonly suggestions: Array<{ modelId: string; suggestion: ModelLifecycleSuggestionInput; at: Date }> = [];

  async findByModelIds(modelIds: readonly string[]): Promise<IModelDiscoveryState[]> {
    return modelIds.map(modelId => this.states.get(modelId)).filter((state): state is IModelDiscoveryState => !!state);
  }

  async recordSighting(modelId: string, at: Date = new Date()): Promise<IModelDiscoveryState> {
    this.sightings.push(modelId);
    return this.write(modelId, { lastSeenAt: at, lastSourceOkAt: at, missCount: 0, firstMissAt: undefined });
  }

  async recordMiss(modelId: string, at: Date = new Date()): Promise<IModelDiscoveryState> {
    this.misses.push(modelId);
    const held = this.states.get(modelId);
    return this.write(modelId, {
      missCount: (held?.missCount ?? 0) + 1,
      firstMissAt: held?.firstMissAt ?? at,
      lastSourceOkAt: at,
    });
  }

  async recordSuggestion(
    modelId: string,
    suggestion: ModelLifecycleSuggestionInput,
    at: Date = new Date()
  ): Promise<IModelDiscoveryState> {
    this.suggestions.push({ modelId, suggestion, at });
    return this.write(modelId, { suggestion: { ...suggestion, suggestedAt: at } });
  }

  private write(modelId: string, patch: Partial<IModelDiscoveryState>): IModelDiscoveryState {
    const held = this.states.get(modelId);
    const next: IModelDiscoveryState = {
      modelId,
      missCount: 0,
      createdAt: held?.createdAt ?? new Date(),
      ...held,
      ...patch,
      updatedAt: new Date(),
    };
    this.states.set(modelId, next);
    return next;
  }
}

export class FakeRunRepository {
  readonly docs: IModelDiscoveryRun[] = [];
  private nextId = 1;

  async create(data: Omit<IModelDiscoveryRunDocument, 'id' | 'createdAt' | 'updatedAt'>) {
    const doc = {
      ...data,
      id: `run-${this.nextId++}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IModelDiscoveryRun;
    this.docs.push(doc);
    return doc as IModelDiscoveryRunDocument;
  }

  async update(data: Partial<IModelDiscoveryRunDocument>) {
    const doc = this.docs.find(candidate => candidate.id === data.id);
    if (!doc) return null;
    Object.assign(doc, data);
    return doc as IModelDiscoveryRunDocument;
  }

  /** Only the one filter shape the runner uses: runs at or after a cutoff. */
  async find(filter: Record<string, unknown>): Promise<IModelDiscoveryRunDocument[]> {
    const since = (filter.startedAt as { $gte?: Date } | undefined)?.$gte;
    const matched = since ? this.docs.filter(doc => doc.startedAt >= since) : this.docs;
    return matched as IModelDiscoveryRunDocument[];
  }
}

export class FakeAdminSettingsRepository {
  constructor(private readonly values: Partial<Record<SettingKey, unknown>> = {}) {}

  async getSettingsValue<K extends SettingKey>(settingName: K): Promise<SettingValue<K> | undefined> {
    if (settingName in this.values) return this.values[settingName] as SettingValue<K>;
    // Unset means "the shipped default", which is what the real repository does
    // when a stored value fails its schema.
    return (settingsMap[settingName] as { defaultValue?: unknown }).defaultValue as SettingValue<K>;
  }
}

export const testCredentials = (overrides: Partial<DiscoveryCredentials> = {}): DiscoveryCredentials => ({
  openai: 'sk-test',
  anthropic: 'sk-test',
  gemini: 'sk-test',
  bfl: 'sk-test',
  xai: 'sk-test',
  kimi: 'sk-test',
  voyageai: 'sk-test',
  ollama: 'http://localhost:11434',
  imageGen: null,
  elevenlabs: null,
  awsIam: true,
  isSelfHost: false,
  ...overrides,
});

/** A full ModelRecord a discovery row can be built from, with the fields under test overridden. */
export const testRecord = (overrides: Partial<ModelRecord> = {}): ModelRecord => ({
  id: 'test-model',
  vendor: 'openai',
  backend: ModelBackend.OpenAI,
  type: 'text',
  name: 'Test Model',
  contextWindow: 128_000,
  adapterFamily: 'openai-chat',
  dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
  ...overrides,
});

export interface StubSourceConfig {
  name: string;
  kind?: DiscoverySource['kind'];
  configured?: boolean;
  /**
   * A thunk stands in for a source whose answer depends on the catalog - an
   * aggregator reads its join targets on every fetch, which is what makes it
   * re-fetchable inside one run.
   */
  records?: DiscoveredModel[] | (() => DiscoveredModel[] | Promise<DiscoveredModel[]>);
  authoritativeFor?: readonly ModelBackend[];
  result?: SourceResult;
  /** Resolves only when the abort signal fires, standing in for a hung endpoint. */
  hang?: boolean;
  onFetch?: () => void;
}

export function stubSource(config: StubSourceConfig): DiscoverySource {
  return {
    name: config.name,
    kind: config.kind ?? 'provider',
    isConfigured: () => config.configured !== false,
    fetch: async ctx => {
      config.onFetch?.();
      if (config.hang) {
        // Never settles on its own: the runner's race against the signal is what
        // has to end it, which is exactly the deadline behavior under test.
        return new Promise<SourceResult>(() => {});
      }
      if (config.result) return config.result;
      void ctx;
      return {
        ok: true,
        records: typeof config.records === 'function' ? await config.records() : (config.records ?? []),
        authoritativeFor: config.authoritativeFor,
      };
    },
  };
}
