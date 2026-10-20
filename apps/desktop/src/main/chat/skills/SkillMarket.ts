import { isAxiosError } from 'axios';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type {
  SkillMarketDetail,
  SkillMarketDetailResult,
  SkillMarketFilters,
  SkillMarketImportRequest,
  SkillMarketImportResult,
  SkillMarketImportsResult,
  SkillMarketListing,
  SkillMarketListingRef,
  SkillMarketPage,
  SkillMarketUpdate,
  SkillMarketVersion,
  SkillMarketWebTarget,
} from '@shared/skillMarket';
import { isExternallyOpenable } from '../../externalLinks';
import { buildDiff } from '../tools/diff';
import type { SkillCatalog } from './SkillCatalog';

const MARKET = '/api/skills/market';
/** The web's page size (useMarketListings), so both clients page the same way. */
const PAGE_SIZE = 24;
/** The route's own cap, and RemoteSkillSource's: the same ceiling on how many skills are seen. */
const SKILLS_LIMIT = 100;
const SIGNED_OUT = 'Sign in to browse the Skill Market.';
const CONFLICT_CODES = new Set(['name_taken', 'local_changes', 'version_changed']);

export interface SkillMarketDeps {
  getApiClient(): AuthenticatedApiClient | null;
  getEnvironmentUrl(): string;
  catalog: Pick<SkillCatalog, 'invalidateAccount' | 'get'>;
  openExternal(url: string): Promise<void>;
  logger: { debug(message: string): void };
}

/**
 * The Skill Market's existing web routes, read from main for the desktop's market panel.
 *
 * Copies ArtifactLibrary's contract: nothing here rejects, a signed-out or failed call comes back
 * as `error` on the result, and server shapes are read defensively because this client does not
 * own them. The routes and their 409 codes are the web's (apps/client/pages/api/skills/market);
 * keep the mapping in step with the web hook's `conflictInfo`.
 */
export class SkillMarket {
  constructor(private readonly deps: SkillMarketDeps) {}

  async browse(filters: SkillMarketFilters, page: number): Promise<SkillMarketPage> {
    const params: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE), sort: filters.sort };
    if (filters.q.trim()) params.q = filters.q.trim();
    if (filters.scope) params.scope = filters.scope;
    if (filters.tools) params.tools = filters.tools;
    if (filters.minRating) params.minRating = String(filters.minRating);
    const read = await this.get(MARKET, params);
    if ('error' in read) return { listings: [], hasMore: false, error: read.error };
    const body = asRecord(read.data);
    return { listings: toListings(body?.data), hasMore: body?.hasMore === true };
  }

  async recommended(): Promise<SkillMarketPage> {
    const read = await this.get(`${MARKET}/recommended`);
    if ('error' in read) return { listings: [], hasMore: false, error: read.error };
    return { listings: toListings(asRecord(read.data)?.data), hasMore: false };
  }

  /** By id, or by an unlisted listing's share token (with or without the id), like the web. */
  async listing(ref: SkillMarketListingRef): Promise<SkillMarketDetailResult> {
    if (typeof ref.id !== 'string' && typeof ref.token !== 'string') return { error: 'No listing to open.' };
    const url = ref.id
      ? `${MARKET}/${encodeURIComponent(ref.id)}`
      : `${MARKET}/by-token/${encodeURIComponent(ref.token ?? '')}`;
    const read = await this.get(url, ref.id && ref.token ? { token: ref.token } : undefined);
    if ('error' in read) return { error: read.error };
    const detail = toDetail(read.data);
    if (!detail) return { error: 'The server returned no listing.' };
    const update = await this.updateFor(detail);
    return { detail: update ? { ...detail, update } : detail };
  }

  async importListing(request: SkillMarketImportRequest): Promise<SkillMarketImportResult> {
    if (typeof request?.listingId !== 'string' || !request.listingId)
      return { ok: false, error: 'No listing to import.' };
    const api = this.deps.getApiClient();
    if (!api) return { ok: false, error: SIGNED_OUT };
    const { listingId, ...rest } = request;
    const body = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
    try {
      const response = await api.getAxiosInstance().post(`${MARKET}/${encodeURIComponent(listingId)}/import`, body);
      const skill = asRecord(asRecord(response.data)?.skill);
      if (typeof skill?.id !== 'string' || typeof skill.name !== 'string') {
        return { ok: false, error: 'The server did not say which skill it created.' };
      }
      this.deps.catalog.invalidateAccount();
      // The CLI store lets a local skill win a name collision, so an import can land and never run.
      const winner = await this.deps.catalog.get(null, skill.name).catch(() => undefined);
      const shadowedByLocal = !!winner && winner.source !== 'remote';
      return { ok: true, skill: { id: skill.id, name: skill.name }, ...(shadowedByLocal ? { shadowedByLocal } : {}) };
    } catch (err) {
      const conflict = isAxiosError(err) && err.response?.status === 409 ? asRecord(err.response.data) : undefined;
      if (conflict) {
        const code = typeof conflict.code === 'string' && CONFLICT_CODES.has(conflict.code) ? conflict.code : undefined;
        return {
          ok: false,
          error: typeof conflict.error === 'string' ? conflict.error : 'That import conflicts with one of your skills.',
          ...(code ? { code: code as 'name_taken' | 'local_changes' | 'version_changed' } : {}),
          ...(typeof conflict.suggestedName === 'string' ? { suggestedName: conflict.suggestedName } : {}),
        };
      }
      const error = describe(err);
      this.deps.logger.debug(`SKILL MARKET: import of ${listingId} failed: ${error}`);
      return { ok: false, error };
    }
  }

  /** The account skills that came from the market, and whether the server has a newer version. */
  async imports(): Promise<SkillMarketImportsResult> {
    const read = await this.get('/api/skills', { limit: String(SKILLS_LIMIT) });
    if ('error' in read) return { imports: [], error: read.error };
    const rows = asArray(asRecord(read.data)?.data);
    return {
      imports: rows.flatMap(row => {
        const skill = asRecord(row);
        const listingId = asRecord(skill?.importedFrom)?.listingId;
        if (typeof skill?.id !== 'string' || typeof skill.name !== 'string' || typeof listingId !== 'string') return [];
        return [
          {
            skillId: skill.id,
            name: skill.name,
            listingId,
            updateAvailable: asRecord(skill.marketStatus)?.state === 'stale',
          },
        ];
      }),
    };
  }

  /** Open the web page for a market item. Main builds the URL so the renderer cannot aim it. */
  async openOnWeb(target: SkillMarketWebTarget): Promise<boolean> {
    const base = this.deps.getEnvironmentUrl().replace(/\/+$/, '');
    const path =
      target?.kind === 'listing' && typeof target.id === 'string'
        ? `/skills/market/${encodeURIComponent(target.id)}`
        : target?.kind === 'skill' && typeof target.id === 'string'
          ? `/skills/${encodeURIComponent(target.id)}`
          : target?.kind === 'mine'
            ? '/skills/market/mine'
            : null;
    if (!path || !isExternallyOpenable(`${base}${path}`)) return false;
    return this.deps.openExternal(`${base}${path}`).then(
      () => true,
      () => false
    );
  }

  /**
   * The update offer for a listing this user imported, when the copy still exists and is on an
   * older version. The diff is the user's copy as it is now against the new version, so local
   * edits show up as part of what an update replaces. A failed read just means no offer.
   */
  private async updateFor(detail: SkillMarketDetail): Promise<SkillMarketUpdate | undefined> {
    const copy = detail.myImport?.skill;
    const version = detail.version;
    if (!copy || !version) return undefined;
    const read = await this.get(`/api/skills/${encodeURIComponent(copy.id)}`);
    if ('error' in read) return undefined;
    const skill = asRecord(read.data);
    const importedFrom = asRecord(skill?.importedFrom);
    if (typeof skill?.body !== 'string' || importedFrom?.versionId === version.id) return undefined;

    const before = asStrings(skill.allowedTools);
    const after = version.snapshot.allowedTools ?? [];
    return {
      skillId: copy.id,
      ...(typeof importedFrom?.version === 'number' ? { fromVersion: importedFrom.version } : {}),
      toVersion: version.version,
      versionId: version.id,
      diff: buildDiff(copy.name, 'edit', skill.body, version.snapshot.body),
      toolsAdded: after.filter(tool => !before.includes(tool)),
      toolsRemoved: before.filter(tool => !after.includes(tool)),
      locallyModified: asRecord(skill.marketStatus)?.locallyModified === true,
    };
  }

  private async get(url: string, params?: Record<string, string>): Promise<{ data: unknown } | { error: string }> {
    const api = this.deps.getApiClient();
    if (!api) return { error: SIGNED_OUT };
    try {
      const response = await api.getAxiosInstance().get(url, params ? { params } : undefined);
      return { data: response.data };
    } catch (err) {
      const error = describe(err);
      this.deps.logger.debug(`SKILL MARKET: GET ${url} failed: ${error}`);
      return { error };
    }
  }
}

function toListings(data: unknown): SkillMarketListing[] {
  return asArray(data)
    .map(toListing)
    .filter((row): row is SkillMarketListing => row !== null);
}

function toListing(row: unknown): SkillMarketListing | null {
  const listing = asRecord(row);
  if (typeof listing?.id !== 'string' || typeof listing.name !== 'string') return null;
  return {
    id: listing.id,
    name: listing.name,
    description: typeof listing.description === 'string' ? listing.description : '',
    ...(typeof listing.authorName === 'string' ? { authorName: listing.authorName } : {}),
    visibility:
      listing.visibility === 'organization' || listing.visibility === 'unlisted' ? listing.visibility : 'public',
    status: typeof listing.status === 'string' ? listing.status : '',
    tags: asStrings(listing.tags),
    ratingAvg: typeof listing.ratingAvg === 'number' ? listing.ratingAvg : 0,
    ratingCount: typeof listing.ratingCount === 'number' ? listing.ratingCount : 0,
    importCount: typeof listing.importCount === 'number' ? listing.importCount : 0,
    ...(listing.riskTier === 'clean' || listing.riskTier === 'review' || listing.riskTier === 'high'
      ? { riskTier: listing.riskTier }
      : {}),
    ...(typeof listing.usesTools === 'boolean' ? { usesTools: listing.usesTools } : {}),
    ...(typeof listing.reason === 'string' ? { reason: listing.reason } : {}),
  };
}

function toDetail(data: unknown): SkillMarketDetail | null {
  const body = asRecord(data);
  const listing = toListing(body?.listing);
  if (!listing) return null;
  const myImport = asRecord(body?.myImport);
  const mySkill = asRecord(myImport?.skill);
  return {
    listing,
    version: toVersion(body?.version),
    myImport: myImport
      ? {
          version: typeof myImport.version === 'number' ? myImport.version : 0,
          skill:
            typeof mySkill?.id === 'string' && typeof mySkill.name === 'string'
              ? { id: mySkill.id, name: mySkill.name }
              : null,
        }
      : null,
    canImport: asRecord(body?.viewer)?.canImport === true,
  };
}

function toVersion(data: unknown): SkillMarketVersion | null {
  const version = asRecord(data);
  const snapshot = asRecord(version?.snapshot);
  if (typeof version?.id !== 'string' || typeof snapshot?.body !== 'string' || typeof snapshot.name !== 'string') {
    return null;
  }
  return {
    id: version.id,
    version: typeof version.version === 'number' ? version.version : 0,
    snapshot: {
      name: snapshot.name,
      description: typeof snapshot.description === 'string' ? snapshot.description : '',
      body: snapshot.body,
      ...(typeof snapshot.argumentHint === 'string' ? { argumentHint: snapshot.argumentHint } : {}),
      allowedTools: asStrings(snapshot.allowedTools),
    },
    ...(asRecord(version.honestSummary)
      ? { honestSummary: version.honestSummary as SkillMarketVersion['honestSummary'] }
      : {}),
    ...(version.riskTier === 'clean' || version.riskTier === 'review' || version.riskTier === 'high'
      ? { riskTier: version.riskTier }
      : {}),
    createdAt: typeof version.createdAt === 'string' ? version.createdAt : '',
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}

function describe(err: unknown): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401) return 'Your session has expired. Sign in again.';
    if (status === 404) return 'That listing is not available.';
    const message = asRecord(err.response?.data)?.error;
    if (status && typeof message === 'string') return message;
    if (status) return `The server answered ${status}.`;
    return 'The server could not be reached.';
  }
  return err instanceof Error ? err.message : 'Unknown error.';
}
