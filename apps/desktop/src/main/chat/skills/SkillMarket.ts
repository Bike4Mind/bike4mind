import { isAxiosError } from 'axios';
import type { OpenDialogOptions } from 'electron';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type {
  SkillActionResult,
  SkillLocalRef,
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
  SkillMarketOrgsResult,
  SkillMarketWebTarget,
  SkillMyListing,
  SkillMyListingsResult,
  SkillPublishRequest,
  SkillSaveRequest,
  SkillSaveResult,
  SkillSubmitResult,
  SkillSubmittedVersion,
  SkillSubmitVersionRequest,
  SkillUploadFields,
  SkillUploadPreview,
  SkillWriteCode,
} from '@shared/skillMarket';
import { isExternallyOpenable } from '@shared/externalLinks';
import { buildDiff } from '../tools/diff';
import type { SkillCatalog } from './SkillCatalog';
import { readSkillSource } from './readSkillSource';

const MARKET = '/api/skills/market';
/** The web's page size (useMarketListings), so both clients page the same way. */
const PAGE_SIZE = 24;
/** The route's own cap, and RemoteSkillSource's: the same ceiling on how many skills are seen. */
const SKILLS_LIMIT = 100;
const SIGNED_OUT = 'Sign in to browse the Skill Market.';
const CONFLICT_CODES = new Set(['name_taken', 'local_changes', 'version_changed']);
const UPLOAD_SIGNED_OUT = 'Sign in to upload skills.';
export const RATE_LIMITED = "You've hit the Skill Market submit limit; try again later.";
const VISIBILITIES = new Set(['public', 'organization', 'unlisted']);

type WriteFailure = { error: string; status?: number; code?: SkillWriteCode };
type OpenDialog = (options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;

export interface SkillMarketDeps {
  getApiClient(): AuthenticatedApiClient | null;
  getEnvironmentUrl(): string;
  catalog: Pick<SkillCatalog, 'invalidateAccount' | 'get'>;
  openExternal(url: string): Promise<void>;
  /** The signed-in user's id, to tell the user's own skills from shared ones. */
  getUserId(): string | null;
  /** The catalog entry Customize listed for this session, resolved in main. */
  localSkill(sessionId: string | null, name: string): Promise<{ source: string; filePath: string } | undefined>;
  writeClipboard(text: string): void;
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
    // Read field by field: this arrives over IPC, and a missing field must not make the call reject.
    const params: Record<string, string> = { page: String(page), limit: String(PAGE_SIZE) };
    if (typeof filters?.sort === 'string') params.sort = filters.sort;
    if (typeof filters?.q === 'string' && filters.q.trim()) params.q = filters.q.trim();
    if (filters?.scope) params.scope = filters.scope;
    if (filters?.tools) params.tools = filters.tools;
    if (filters?.minRating) params.minRating = String(filters.minRating);
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
   * A local skill Customize listed, for the upload preview. Only a file the catalog resolves for
   * this session is read, so the renderer cannot name an arbitrary path.
   */
  async readLocalSkill(ref: SkillLocalRef): Promise<SkillUploadPreview> {
    if (!this.deps.getApiClient()) return { ok: false, error: UPLOAD_SIGNED_OUT };
    if (typeof ref?.name !== 'string') return { ok: false, error: 'No skill to upload.' };
    const sessionId = typeof ref.sessionId === 'string' ? ref.sessionId : null;
    const command = await this.deps.localSkill(sessionId, ref.name).catch(() => undefined);
    if (!command || command.source === 'remote')
      return { ok: false, error: 'That skill is not a file on this machine.' };
    return readSkillSource(command.filePath);
  }

  /** The native picker, then the read: the picked path never goes through the renderer. */
  async pickUploadSource(open: OpenDialog): Promise<SkillUploadPreview> {
    if (!this.deps.getApiClient()) return { ok: false, error: UPLOAD_SIGNED_OUT };
    const picked = await open({
      title: 'Upload a skill',
      buttonLabel: 'Upload',
      // Elsewhere openFile + openDirectory is a folder-only dialog, so a SKILL.md is picked as a file.
      properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters: [{ name: 'Skill', extensions: ['md'] }],
    }).catch(() => ({ canceled: true, filePaths: [] }));
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: '', canceled: true };
    return readSkillSource(picked.filePaths[0]);
  }

  /**
   * Save to the account. `create` answers `name_taken` (with the existing skill) instead of
   * overwriting, so replacing a skill is always the user's explicit `update`.
   */
  async saveSkill(request: SkillSaveRequest): Promise<SkillSaveResult> {
    const fields = toFields(request?.fields);
    if (!fields) return { ok: false, error: 'Nothing to save.' };
    const userId = this.deps.getUserId();
    if (!this.deps.getApiClient() || !userId) return { ok: false, error: UPLOAD_SIGNED_OUT, code: 'signed_out' };

    let id: string;
    if (request.mode === 'update') {
      if (typeof request.targetSkillId !== 'string') return { ok: false, error: 'No skill to update.' };
      const read = await this.get(`/api/skills/${encodeURIComponent(request.targetSkillId)}`, undefined, true);
      if ('error' in read) return { ok: false, error: read.error };
      const target = asRecord(read.data);
      if (target?.userId !== userId) return { ok: false, error: 'You can only update your own skills.' };
      // Overwriting a market import with local content would break its update tracking.
      if (target.importedFrom) return { ok: false, error: 'That skill was imported from the market. Rename instead.' };
      id = request.targetSkillId;
      const put = await this.send('put', `/api/skills/${encodeURIComponent(id)}`, fields);
      if ('error' in put) return failure(put);
    } else {
      const existing = await this.findOwn(fields.name, userId);
      if ('error' in existing) return { ok: false, error: existing.error };
      if (existing.skill) return nameTaken(fields.name, existing.skill);
      const post = await this.send('post', '/api/skills', fields);
      if ('error' in post) {
        if (post.status === 400 && /already exists/i.test(post.error)) {
          const raced = await this.findOwn(fields.name, userId);
          if ('skill' in raced && raced.skill) return nameTaken(fields.name, raced.skill);
        }
        return failure(post);
      }
      const created = asRecord(post.data);
      if (typeof created?.id !== 'string')
        return { ok: false, error: 'The server did not say which skill it created.' };
      id = created.id;
    }

    this.deps.catalog.invalidateAccount();
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null;
    const winner = await this.deps.localSkill(sessionId, fields.name).catch(() => undefined);
    const shadowedByLocal = !!winner && winner.source !== 'remote';
    const listing =
      request.mode === 'update'
        ? (await this.mineRows()).find(row => row.sourceSkillId === id && isOpen(row.status))
        : undefined;
    return {
      ok: true,
      skill: { id, name: fields.name },
      ...(shadowedByLocal ? { shadowedByLocal } : {}),
      ...(typeof listing?.id === 'string' ? { listing: { id: listing.id, name: String(listing.name) } } : {}),
    };
  }

  /** The organizations the user can publish to (the web's useMarketMe). */
  async organizations(): Promise<SkillMarketOrgsResult> {
    const read = await this.get(`${MARKET}/me`);
    if ('error' in read) return { organizations: [], error: read.error };
    return {
      organizations: asArray(asRecord(read.data)?.organizations).flatMap(row => {
        const org = asRecord(row);
        return typeof org?.id === 'string' && typeof org.name === 'string' ? [{ id: org.id, name: org.name }] : [];
      }),
    };
  }

  /** A 409 means the skill already has a listing; the answer names it so the dialog submits a version. */
  async publish(request: SkillPublishRequest): Promise<SkillSubmitResult> {
    if (typeof request?.skillId !== 'string' || !VISIBILITIES.has(request.visibility)) {
      return { ok: false, error: 'Nothing to publish.' };
    }
    const sent = await this.send('post', `${MARKET}/publish`, {
      skillId: request.skillId,
      visibility: request.visibility,
      ...(request.visibility === 'organization' && typeof request.organizationId === 'string'
        ? { organizationId: request.organizationId }
        : {}),
      tags: asStrings(request.tags),
    });
    if (!('error' in sent)) return submitted(sent.data);
    if (sent.status !== 409) return failure(sent);
    const listing = (await this.mineRows()).find(row => row.sourceSkillId === request.skillId && isOpen(row.status));
    return {
      ok: false,
      error: sent.error,
      code: 'already_listed',
      ...(typeof listing?.id === 'string' ? { listingId: listing.id } : {}),
    };
  }

  /**
   * A new version snapshots the listing's source skill as the server has it, so local content is
   * written there first. A failed submission after that write is not rolled back.
   */
  async submitVersion(request: SkillSubmitVersionRequest): Promise<SkillSubmitResult> {
    if (typeof request?.listingId !== 'string') return { ok: false, error: 'No listing to update.' };
    if (!this.deps.getApiClient()) return { ok: false, error: UPLOAD_SIGNED_OUT, code: 'signed_out' };
    const fields = request.fields === undefined ? undefined : toFields(request.fields);
    if (request.fields !== undefined && !fields) return { ok: false, error: 'Nothing to submit.' };

    let skillUpdated = false;
    if (fields) {
      const read = await this.get(`${MARKET}/mine`);
      if ('error' in read) return { ok: false, error: read.error };
      const listing = asArray(asRecord(read.data)?.data)
        .map(asRecord)
        .find(row => row?.id === request.listingId);
      if (typeof listing?.sourceSkillId !== 'string') return { ok: false, error: 'That listing is not one of yours.' };
      if (!isOpen(listing.status)) return { ok: false, error: 'That listing no longer accepts new versions.' };
      const put = await this.send('put', `/api/skills/${encodeURIComponent(listing.sourceSkillId)}`, fields);
      if ('error' in put) return failure(put);
      skillUpdated = true;
      this.deps.catalog.invalidateAccount();
    }
    // No tags: like the web's My listings, a new version keeps the listing's tags.
    const sent = await this.send('post', `${MARKET}/${encodeURIComponent(request.listingId)}/versions`, {});
    if ('error' in sent) return { ...failure(sent), ...(skillUpdated ? { skillUpdated } : {}) };
    return submitted(sent.data);
  }

  async mine(): Promise<SkillMyListingsResult> {
    const read = await this.get(`${MARKET}/mine`);
    if ('error' in read) return { listings: [], error: read.error };
    return {
      listings: asArray(asRecord(read.data)?.data)
        .map(toMyListing)
        .filter((row): row is SkillMyListing => row !== null),
    };
  }

  async withdraw(listingId: string): Promise<SkillActionResult> {
    if (typeof listingId !== 'string' || !listingId) return { ok: false, error: 'No listing to withdraw.' };
    const sent = await this.send('delete', `${MARKET}/${encodeURIComponent(listingId)}`);
    return 'error' in sent ? failure(sent) : { ok: true };
  }

  /** Main builds the link and writes the clipboard, so the share token never reaches the renderer. */
  async copyShareLink(listingId: string): Promise<SkillActionResult> {
    if (!this.deps.getApiClient()) return { ok: false, error: UPLOAD_SIGNED_OUT, code: 'signed_out' };
    const listing = (await this.mineRows()).find(row => row.id === listingId);
    if (listing?.visibility !== 'unlisted' || typeof listing.shareToken !== 'string' || !listing.shareToken) {
      return { ok: false, error: 'That listing has no share link.' };
    }
    const base = this.deps.getEnvironmentUrl().replace(/\/+$/, '');
    this.deps.writeClipboard(`${base}/skills/market/u/${encodeURIComponent(listing.shareToken)}`);
    return { ok: true };
  }

  /** Open an exported file's `Bike4Mind-Source:` link, through the app-wide external-link guard. */
  async openSourceUrl(url: string): Promise<boolean> {
    if (typeof url !== 'string' || !isExternallyOpenable(url)) return false;
    return this.deps.openExternal(url).then(
      () => true,
      () => false
    );
  }

  /** The user's own skill named exactly `name`. The search is fuzzy and includes shared skills. */
  private async findOwn(
    name: string,
    userId: string
  ): Promise<{ skill?: Record<string, unknown> } | { error: string }> {
    const read = await this.get('/api/skills', { query: name, limit: String(SKILLS_LIMIT) });
    if ('error' in read) return read;
    const skill = asArray(asRecord(read.data)?.data)
      .map(asRecord)
      .find(row => row?.userId === userId && row.name === name && typeof row.id === 'string');
    return skill ? { skill } : {};
  }

  /** My listings as the server sends them (privileged: share token, source skill). Empty on failure. */
  private async mineRows(): Promise<Record<string, unknown>[]> {
    const read = await this.get(`${MARKET}/mine`);
    if ('error' in read) return [];
    return asArray(asRecord(read.data)?.data).flatMap(row => {
      const record = asRecord(row);
      return record ? [record] : [];
    });
  }

  private async send(
    method: 'post' | 'put' | 'delete',
    url: string,
    body?: unknown
  ): Promise<{ data: unknown } | WriteFailure> {
    const api = this.deps.getApiClient();
    if (!api) return { error: UPLOAD_SIGNED_OUT, code: 'signed_out' };
    try {
      const http = api.getAxiosInstance();
      const response = method === 'delete' ? await http.delete(url) : await http[method](url, body);
      return { data: response.data };
    } catch (err) {
      const status = isAxiosError(err) ? err.response?.status : undefined;
      const error = describe(err, { write: true });
      this.deps.logger.debug(`SKILL MARKET: ${method.toUpperCase()} ${url} failed: ${error}`);
      const code: SkillWriteCode | undefined =
        status === 429 ? 'rate_limited' : status === 400 && /exact content/i.test(error) ? 'exact_content' : undefined;
      return { error, ...(status ? { status } : {}), ...(code ? { code } : {}) };
    }
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

    const before = [...asStrings(skill.allowedTools), ...asStrings(skill.claudeCodeAllowedTools)];
    const after = [...(version.snapshot.allowedTools ?? []), ...(version.snapshot.claudeCodeAllowedTools ?? [])];
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

  private async get(
    url: string,
    params?: Record<string, string>,
    write = false
  ): Promise<{ data: unknown } | { error: string }> {
    const api = this.deps.getApiClient();
    if (!api) return { error: SIGNED_OUT };
    try {
      const response = await api.getAxiosInstance().get(url, params ? { params } : undefined);
      return { data: response.data };
    } catch (err) {
      const error = describe(err, { write });
      this.deps.logger.debug(`SKILL MARKET: GET ${url} failed: ${error}`);
      return { error };
    }
  }
}

/** The upload fields, picked one by one so nothing else (allowedTools above all) is ever sent. */
function toFields(value: unknown): SkillUploadFields | null {
  const fields = asRecord(value);
  if (typeof fields?.name !== 'string' || typeof fields.description !== 'string' || typeof fields.body !== 'string') {
    return null;
  }
  return {
    name: fields.name,
    description: fields.description,
    body: fields.body,
    argumentHint: typeof fields.argumentHint === 'string' ? fields.argumentHint : '',
    // Always sent, like argumentHint, so an update clears tools the file no longer declares.
    claudeCodeAllowedTools: Array.isArray(fields.claudeCodeAllowedTools)
      ? fields.claudeCodeAllowedTools.filter((tool): tool is string => typeof tool === 'string')
      : [],
    disableModelInvocation: fields.disableModelInvocation === true,
    // Always sent, so re-uploading over a skill replaces its files (the server validates paths and limits).
    files: (Array.isArray(fields.files) ? fields.files : []).flatMap(file => {
      const f = asRecord(file);
      return typeof f?.path === 'string' && typeof f.content === 'string' ? [{ path: f.path, content: f.content }] : [];
    }),
  };
}

function failure(sent: WriteFailure): { ok: false; error: string; code?: SkillWriteCode } {
  return { ok: false, error: sent.error, ...(sent.code ? { code: sent.code } : {}) };
}

function nameTaken(name: string, skill: Record<string, unknown>): SkillSaveResult {
  return {
    ok: false,
    error: `You already have a skill named "${name}".`,
    code: 'name_taken',
    existing: { id: String(skill.id), imported: !!skill.importedFrom },
  };
}

const isOpen = (status: unknown) => status !== 'withdrawn' && status !== 'delisted';

function submitted(data: unknown): SkillSubmitResult {
  const body = asRecord(data);
  const listing = toMyListing(body?.listing);
  const version = asRecord(body?.version);
  if (!listing || typeof version?.version !== 'number') return { ok: false, error: 'The server returned no listing.' };
  return { ok: true, listing, version: toSubmittedVersion(version) };
}

function toSubmittedVersion(version: Record<string, unknown>): SkillSubmittedVersion {
  return {
    version: typeof version.version === 'number' ? version.version : 0,
    scanStatus: typeof version.scanStatus === 'string' ? version.scanStatus : '',
    reviewStatus: typeof version.reviewStatus === 'string' ? version.reviewStatus : '',
    ...(isRiskTier(version.riskTier) ? { riskTier: version.riskTier } : {}),
    ...(typeof version.reviewNote === 'string' ? { reviewNote: version.reviewNote } : {}),
    findings: asArray(version.scanFindings).flatMap(row => {
      const finding = asRecord(row);
      return typeof finding?.message === 'string'
        ? [{ severity: typeof finding.severity === 'string' ? finding.severity : '', message: finding.message }]
        : [];
    }),
  };
}

function toMyListing(row: unknown): SkillMyListing | null {
  const listing = asRecord(row);
  if (typeof listing?.id !== 'string' || typeof listing.name !== 'string') return null;
  // /mine sends the newest versions first.
  const latest = asRecord(asArray(listing.versions)[0]);
  return {
    id: listing.id,
    name: listing.name,
    visibility:
      listing.visibility === 'organization' || listing.visibility === 'unlisted' ? listing.visibility : 'public',
    status: typeof listing.status === 'string' ? listing.status : '',
    hiddenByReports: listing.hiddenByReports === true,
    tags: asStrings(listing.tags),
    ...(typeof listing.currentVersion === 'number' ? { currentVersion: listing.currentVersion } : {}),
    ...(typeof listing.pendingVersion === 'number' ? { pendingVersion: listing.pendingVersion } : {}),
    ...(latest && typeof latest.version === 'number'
      ? {
          latest: {
            version: latest.version,
            reviewStatus: typeof latest.reviewStatus === 'string' ? latest.reviewStatus : '',
            ...(isRiskTier(latest.riskTier) ? { riskTier: latest.riskTier } : {}),
            ...(typeof latest.reviewNote === 'string' ? { reviewNote: latest.reviewNote } : {}),
          },
        }
      : {}),
    ...(typeof listing.delistedReason === 'string' ? { delistedReason: listing.delistedReason } : {}),
    hasShareLink: listing.visibility === 'unlisted' && typeof listing.shareToken === 'string' && !!listing.shareToken,
  };
}

function isRiskTier(value: unknown): value is 'clean' | 'review' | 'high' {
  return value === 'clean' || value === 'review' || value === 'high';
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
      claudeCodeAllowedTools: asStrings(snapshot.claudeCodeAllowedTools),
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

/** `write`: a 404 on a write means different things per route, so the server's own message is kept. */
function describe(err: unknown, { write = false } = {}): string {
  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (status === 401) return 'Your session has expired. Sign in again.';
    if (status === 429) return RATE_LIMITED;
    if (status === 404 && !write) return 'That listing is not available.';
    const message = asRecord(err.response?.data)?.error;
    if (status && typeof message === 'string') return message;
    if (status) return `The server answered ${status}.`;
    return 'The server could not be reached.';
  }
  return err instanceof Error ? err.message : 'Unknown error.';
}
