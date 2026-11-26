import { floorUptimeFraction } from './uptimeDisplay';
import { truncateToSchemaCap } from './bounds';
import { cmpStr, cmpTime } from './compare';
import { isActive, maintenanceEffectiveEndMs, toEpochMs, type ActivityFacts } from './isActive';
import { classifyLink, normalizeLinkHost, type LinkPolicyOptions } from './linkPolicy';
import { sanitizeMarkdown } from './markdown';
import {
  PublicArchiveSchema,
  PublicComponentSchema,
  PublicIncidentDetailSchema,
  PublicIncidentHeadSchema,
  PublicIncidentsIndexSchema,
  PublicSummarySchema,
  PublicUptimeSchema,
  SUPPORT_EMAIL_MAX_LENGTH,
  SUPPORT_EMAIL_PATTERN,
  type PublicArchive,
  type PublicComponent,
  type PublicIncidentDetail,
  type PublicIncidentHead,
  type PublicIncidentIndexRow,
  type PublicIncidentsIndex,
  type PublicSummary,
  type PublicUpdate,
  type PublicUptime,
} from './schemas.public';
import {
  applySummarySizeLadder,
  checkFileSize,
  fitIncidentIndex,
  jsonByteLength,
  STATUS_FILE_SIZE_CAPS,
} from './sizeLadder';
import {
  displayedBaseState,
  displayedState,
  impactSeverity,
  uncoveredIncidentState,
  vendorIndicatorToState,
  worstState,
  type ComponentImpact,
  type DisplayState,
} from './stateOrder';
import { incidentPublicTextLength, validatePublicText } from './textPolicy';
import {
  MAX_INCIDENT_UPDATES,
  PUBLIC_SLUG_PATTERN,
  STATUS_HARD_STALE_AFTER_SECONDS,
  STATUS_SCHEMA_VERSION,
  STATUS_STALE_AFTER_SECONDS,
  STATUS_UPTIME_WINDOW_DAYS,
  SUMMARY_LATEST_UPDATES,
  TEXT_LIMITS,
  UPCOMING_MAINTENANCE_DAYS,
  type ProbesTrigger,
  type StatusComponentRuntime,
  type StatusGroupDef,
  type StatusIncidentDoc,
  type StatusIncidentUpdateDoc,
  type UptimeComponentInput,
} from './types';

export interface ProjectionInput {
  now: Date;
  /** Monotonic publish revision shared by the summary and complete incidents index. */
  seq: number;
  /** Finish time of the last tick that evaluated probes; non-tick publishes carry it forward. */
  probesAsOf: Date;
  probesTrigger: ProbesTrigger | null;
  breakglassAppliedSeq: number;
  externalIgnoredUntil: Date | null;
  page: { title: string; appUrl: string; linkHosts: readonly string[]; supportEmail?: string | null };
  notice?: 'offline' | null;
  groups: readonly StatusGroupDef[];
  components: readonly StatusComponentRuntime[];
  incidents: readonly StatusIncidentDoc[];
  uptime?: readonly UptimeComponentInput[];
  staleAfterSeconds?: number;
  hardStaleAfterSeconds?: number;
  summarySizeCap?: number;
}

export interface ProjectionDrop {
  file: 'summary' | 'incident' | 'incidents' | 'archive' | 'uptime';
  /** Internal reference for the admin alert; never serialized into a public file. */
  ref: string;
  reason: string;
}

export interface ProjectedSnapshot {
  summary: PublicSummary;
  summaryLadderSteps: number[];
  incidentsIndex: PublicIncidentsIndex;
  incidentFiles: Record<string, PublicIncidentDetail>;
  archives: Record<string, PublicArchive>;
  uptime: PublicUptime;
  dropped: ProjectionDrop[];
  warnings: string[];
}

export class StatusProjectionError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isoOrNull(date: Date | undefined | null): string | null {
  return date ? iso(date) : null;
}

function activityFacts(doc: StatusIncidentDoc): ActivityFacts {
  return {
    kind: doc.kind,
    published: doc.published,
    retracted: doc.retracted,
    status: doc.status,
    resolvedAt: doc.resolvedAt,
    scheduledStartAt: doc.scheduledStartAt,
    scheduledEndAt: doc.scheduledEndAt,
    completedEarlyAt: doc.completedEarlyAt,
    cancelledAt: doc.cancelledAt,
  };
}

function severityOrder(a: PublicIncidentHead, b: PublicIncidentHead): number {
  return impactSeverity(b.impact) - impactSeverity(a.impact) || cmpTime(b.updatedAt, a.updatedAt) || cmpStr(a.id, b.id);
}

interface IncidentProjection {
  doc: StatusIncidentDoc;
  head: PublicIncidentHead;
  detail: PublicIncidentDetail;
  row: PublicIncidentIndexRow;
}

interface DropSink {
  dropped: ProjectionDrop[];
  warnings: string[];
}

const MAX_LINK_HOSTS = 200;
const MAX_LINK_HOST_LENGTH = 253;

function cleanLinkHosts(raw: unknown, warnings: string[]): string[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const usable = list
    .filter((host): host is string => typeof host === 'string')
    .map(normalizeLinkHost)
    .filter(host => host !== '' && host.length <= MAX_LINK_HOST_LENGTH);
  if (!Array.isArray(raw) || usable.length !== list.length) warnings.push('link_hosts_invalid_entries');
  const hosts = [...new Set(usable)].sort(cmpStr);
  if (hosts.length > MAX_LINK_HOSTS) warnings.push('link_hosts_trimmed');
  return hosts.slice(0, MAX_LINK_HOSTS);
}

function cleanSupportEmail(raw: unknown, warnings: string[]): string | null {
  if (raw === undefined || raw === null) return null;
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (email.length <= SUPPORT_EMAIL_MAX_LENGTH && SUPPORT_EMAIL_PATTERN.test(email)) return email;
  warnings.push('support_email_invalid');
  return null;
}

/** Fixed codes only: error text can carry internal values. Top-level projection errors keep propagating. */
function dropReason(error: unknown): string {
  if (error instanceof StatusProjectionError) throw error;
  return error instanceof RangeError ? 'invalid_date' : 'malformed_record';
}

/** A record that throws (an Invalid Date, a null field) is dropped instead of the whole publish. */
function guarded<T>(build: () => T | { reason: string }): T | { reason: string } {
  try {
    return build();
  } catch (error) {
    return { reason: dropReason(error) };
  }
}

function refOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function lengthOnly(result: { ok: boolean; errors: { code: string }[] }): boolean {
  return !result.ok && result.errors.every(error => error.code === 'too_long');
}

/**
 * Builds every public file from admin-tier inputs. Public values are copied by name from an
 * allowlist; nothing is spread, and internal keys, contributor ids, notes, authors, sources and
 * classification never reach the output. A record that fails a text rule or the strict parse is
 * dropped from its file and reported in `dropped`; the rest publishes.
 */
export function projectPublicSnapshot(input: ProjectionInput): ProjectedSnapshot {
  const dropped: ProjectionDrop[] = [];
  const warnings: string[] = [];
  const now = input.now;
  for (const [name, value] of [
    ['now', input.now],
    ['probesAsOf', input.probesAsOf],
    ['externalIgnoredUntil', input.externalIgnoredUntil ?? input.now],
  ] as const) {
    if (!Number.isFinite(value.getTime())) throw new StatusProjectionError(`${name} is not a valid date`);
  }
  const linkHosts = cleanLinkHosts(input.page.linkHosts, warnings);
  const supportEmail = cleanSupportEmail(input.page.supportEmail, warnings);
  const linkOptions: LinkPolicyOptions = { linkHosts, supportEmail };
  const sink: DropSink = { dropped, warnings };

  const pageTitle = validatePublicText('label', input.page.title, linkOptions);
  if (!pageTitle.ok) throw new StatusProjectionError('page title failed the text policy');

  const visible = input.components.filter(
    runtime => runtime?.component?.visibility === 'public' && !runtime.component.retiredAt
  );

  const groupBySlug = new Map<string, StatusGroupDef>();
  for (const group of input.groups) {
    try {
      const name = typeof group.name === 'string' ? validatePublicText('label', group.name, linkOptions) : null;
      if (!name || !PUBLIC_SLUG_PATTERN.test(group.slug) || !Number.isInteger(group.order)) {
        dropped.push({ file: 'summary', ref: String(group.slug), reason: 'group_schema' });
      } else if (name.ok) groupBySlug.set(group.slug, { ...group, name: name.normalized.trim() });
      else dropped.push({ file: 'summary', ref: group.slug, reason: 'group_text_policy' });
    } catch (error) {
      dropped.push({ file: 'summary', ref: refOf(group?.slug), reason: dropReason(error) });
    }
  }

  // The public set is settled once, before anything refers to a slug: a row that is dropped here
  // (bad text, unknown group, missing or nested parent) is absent from incidents and uptime too.
  const candidates = new Map<string, PublicComponent>();
  const componentText = new Map<StatusComponentRuntime, ComponentText>();
  for (const runtime of visible) {
    const row = guarded(() => {
      if (!groupBySlug.has(runtime.component.group)) return { reason: 'unknown_group' };
      const text = validateComponentText(runtime.component, linkOptions);
      if ('reason' in text) return text;
      componentText.set(runtime, text);
      return projectComponent(runtime, text, new Map(), new Map());
    });
    if ('reason' in row) dropped.push({ file: 'summary', ref: runtime.component.key, reason: row.reason });
    else candidates.set(runtime.component.key, row);
  }
  const parentKeyOf = new Map(visible.map(({ component }) => [component.key, component.parentKey]));
  const publicKeys = new Set<string>();
  for (const [key, row] of candidates) {
    const parentKey = parentKeyOf.get(key);
    if (!parentKey) {
      publicKeys.add(key);
      continue;
    }
    if (!candidates.has(parentKey)) {
      dropped.push({ file: 'summary', ref: key, reason: 'parent_not_public' });
    } else if (parentKeyOf.get(parentKey)) {
      dropped.push({ file: 'summary', ref: key, reason: 'nested_too_deep' });
    } else if (!PublicComponentSchema.shape.children.element.safeParse(toChildRow(row)).success) {
      dropped.push({ file: 'summary', ref: key, reason: 'schema' });
    } else publicKeys.add(key);
  }
  const publicRuntimes = visible.filter(({ component }) => publicKeys.has(component.key));
  const slugByKey = new Map(publicRuntimes.map(({ component }) => [component.key, component.publicSlug]));

  const eligible = input.incidents.filter(doc => doc.published && !doc.retracted);
  const projections: IncidentProjection[] = [];
  for (const doc of eligible) {
    const projected = guarded(() => projectIncident(doc, slugByKey, linkOptions, now, sink));
    if ('reason' in projected) dropped.push({ file: 'incident', ref: doc.publicId, reason: projected.reason });
    else projections.push(projected);
  }
  const projectedIds = new Set(projections.map(p => p.doc.publicId));

  const activeImpactsByKey = new Map<string, ComponentImpact[]>();
  const maintenanceByKey = new Map<string, { incidentId: string; endsAtMs: number; startMs: number }>();
  for (const { doc } of projections) {
    if (!isActive(activityFacts(doc), now)) continue;
    for (const listed of doc.components) {
      if (doc.kind === 'incident') {
        const impacts = activeImpactsByKey.get(listed.componentKey) ?? [];
        impacts.push(listed.impact);
        activeImpactsByKey.set(listed.componentKey, impacts);
      } else {
        const endsAtMs = maintenanceEffectiveEndMs(doc);
        const startMs = toEpochMs(doc.scheduledStartAt);
        const current = maintenanceByKey.get(listed.componentKey);
        if (endsAtMs !== null && startMs !== null && (!current || startMs < current.startMs)) {
          maintenanceByKey.set(listed.componentKey, { incidentId: doc.publicId, endsAtMs, startMs });
        }
      }
    }
  }

  const rows = new Map<string, PublicComponent>();
  for (const runtime of publicRuntimes) {
    const text = componentText.get(runtime);
    if (!text) continue;
    const row = guarded(() => projectComponent(runtime, text, activeImpactsByKey, maintenanceByKey));
    if ('reason' in row) dropped.push({ file: 'summary', ref: runtime.component.key, reason: row.reason });
    else rows.set(runtime.component.key, row);
  }
  const topLevel: PublicComponent[] = [];
  for (const [key, row] of rows) {
    const parentKey = parentKeyOf.get(key);
    if (!parentKey) {
      topLevel.push(row);
      continue;
    }
    const parsed = PublicComponentSchema.shape.children.element.safeParse(toChildRow(row));
    const parent = rows.get(parentKey);
    if (parsed.success && parent) parent.children.push(parsed.data);
    else dropped.push({ file: 'summary', ref: key, reason: parsed.success ? 'parent_not_public' : 'schema' });
  }
  topLevel.sort(
    (a, b) =>
      (groupBySlug.get(a.group)?.order ?? 0) - (groupBySlug.get(b.group)?.order ?? 0) ||
      a.order - b.order ||
      cmpStr(a.slug, b.slug)
  );
  for (const row of topLevel) row.children.sort((a, b) => a.order - b.order || cmpStr(a.slug, b.slug));

  const usedGroups = new Set(topLevel.map(row => row.group));
  const groups = [...groupBySlug.values()]
    .filter(group => usedGroups.has(group.slug))
    .sort((a, b) => a.order - b.order || cmpStr(a.slug, b.slug))
    .map(group => ({ slug: group.slug, name: group.name, order: group.order }));

  const allStates: DisplayState[] = topLevel.flatMap(row => [row.state, ...row.children.map(child => child.state)]);

  const upcomingCutoff = now.getTime() + UPCOMING_MAINTENANCE_DAYS * DAY_MS;
  const active = projections.filter(p => isActive(activityFacts(p.doc), now)).map(p => p.head);
  const pageSlugs = new Set(topLevel.flatMap(row => [row.slug, ...row.children.map(child => child.slug)]));
  const uncovered = uncoveredIncidentState(active, pageSlugs);
  const upcoming = projections
    .filter(({ doc }) => {
      if (doc.kind !== 'maintenance' || doc.status === 'cancelled' || doc.cancelledAt) return false;
      const start = toEpochMs(doc.scheduledStartAt);
      const end = maintenanceEffectiveEndMs(doc);
      return start !== null && end !== null && start > now.getTime() && start <= upcomingCutoff && end > start;
    })
    .map(p => p.head)
    .sort((a, b) => cmpTime(a.scheduledStartAt ?? '', b.scheduledStartAt ?? '') || cmpStr(a.id, b.id));

  const summaryCandidate = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    seq: input.seq,
    generatedAt: iso(now),
    probesAsOf: iso(input.probesAsOf),
    probesTrigger: input.probesTrigger,
    staleAfterSeconds: input.staleAfterSeconds ?? STATUS_STALE_AFTER_SECONDS,
    hardStaleAfterSeconds: input.hardStaleAfterSeconds ?? STATUS_HARD_STALE_AFTER_SECONDS,
    breakglassAppliedSeq: input.breakglassAppliedSeq,
    externalIgnoredUntil: isoOrNull(input.externalIgnoredUntil),
    page: { title: pageTitle.normalized.trim(), appUrl: input.page.appUrl, linkHosts, supportEmail },
    overall: { state: worstState([...allStates, uncovered]), notice: input.notice ?? null },
    groups,
    components: topLevel,
    activeIncidents: active.sort(severityOrder),
    upcomingMaintenance: upcoming,
    moreActiveIncidents: 0,
  };
  const strictSummary = PublicSummarySchema.safeParse(summaryCandidate);
  if (!strictSummary.success) throw new StatusProjectionError('summary failed the strict parse');
  const ladder = applySummarySizeLadder(strictSummary.data, input.summarySizeCap ?? STATUS_FILE_SIZE_CAPS.summary);
  for (const step of ladder.appliedSteps) warnings.push(`summary_size_ladder_step_${step}`);
  if (ladder.overCap) warnings.push('summary_over_cap_after_ladder');

  const windowStart = now.getTime() - STATUS_UPTIME_WINDOW_DAYS * DAY_MS;
  const newestFirst = (a: IncidentProjection, b: IncidentProjection) =>
    cmpTime(b.row.startedAt, a.row.startedAt) || cmpStr(a.row.id, b.row.id);
  const inWindow = projections
    .filter(({ doc }) => {
      const end = toEpochMs(doc.resolvedAt) ?? maintenanceEffectiveEndMs(doc) ?? now.getTime();
      return end >= windowStart;
    })
    .sort(newestFirst)
    .map(p => p.row);
  const measureIndex = (rowsToMeasure: PublicIncidentIndexRow[]) =>
    jsonByteLength({
      schemaVersion: STATUS_SCHEMA_VERSION,
      seq: input.seq,
      generatedAt: iso(now),
      windowDays: STATUS_UPTIME_WINDOW_DAYS,
      incidents: rowsToMeasure,
    });
  const fitted = fitIncidentIndex(inWindow, measureIndex, STATUS_FILE_SIZE_CAPS.incidents);
  if (fitted.dropped > 0) warnings.push('incidents_index_dropped_oldest_resolved');
  if (fitted.overCap) warnings.push('incidents_index_over_cap');
  const indexCandidate = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    seq: input.seq,
    generatedAt: iso(now),
    windowDays: STATUS_UPTIME_WINDOW_DAYS,
    incidents: fitted.rows,
  };
  const strictIndex = PublicIncidentsIndexSchema.safeParse(indexCandidate);
  if (!strictIndex.success) throw new StatusProjectionError('incidents.json failed the strict parse');

  const incidentFiles: Record<string, PublicIncidentDetail> = {};
  const byYear = new Map<number, PublicIncidentIndexRow[]>();
  for (const projection of [...projections].sort(newestFirst)) {
    incidentFiles[projection.doc.publicId] = projection.detail;
    const year = projection.doc.startedAt.getUTCFullYear();
    byYear.set(year, [...(byYear.get(year) ?? []), projection.row]);
  }
  const archives: Record<string, PublicArchive> = {};
  for (const [year, yearRows] of byYear) {
    const archiveFit = fitIncidentIndex(
      yearRows,
      list => jsonByteLength({ schemaVersion: STATUS_SCHEMA_VERSION, year, incidents: list }),
      STATUS_FILE_SIZE_CAPS.archive
    );
    if (archiveFit.dropped > 0) warnings.push(`archive_${year}_dropped_oldest_resolved`);
    const parsed = PublicArchiveSchema.safeParse({
      schemaVersion: STATUS_SCHEMA_VERSION,
      year,
      incidents: archiveFit.rows,
    });
    if (parsed.success) archives[String(year)] = parsed.data;
    else dropped.push({ file: 'archive', ref: String(year), reason: 'schema' });
  }

  const uptime = projectUptime(input, publicRuntimes, slugByKey, projectedIds, sink);

  return {
    summary: ladder.summary,
    summaryLadderSteps: ladder.appliedSteps,
    incidentsIndex: strictIndex.data,
    incidentFiles,
    archives,
    uptime,
    dropped,
    warnings,
  };
}

function toChildRow(row: PublicComponent) {
  const { group: _group, children: _children, ...child } = row;
  return child;
}

interface ComponentText {
  name: string;
  description: string | null;
}

function validateComponentText(
  component: StatusComponentRuntime['component'],
  linkOptions: LinkPolicyOptions
): ComponentText | { reason: string } {
  const name = validatePublicText('label', component.name, linkOptions);
  if (!name.ok) return { reason: 'text_policy' };
  let description: string | null = null;
  if (component.description !== undefined && component.description !== '') {
    const checked = validatePublicText('componentDescription', component.description, linkOptions);
    if (!checked.ok) return { reason: 'text_policy' };
    description = checked.normalized.trim();
  }
  return { name: name.normalized.trim(), description };
}

function projectComponent(
  runtime: StatusComponentRuntime,
  text: ComponentText,
  activeImpacts: Map<string, ComponentImpact[]>,
  maintenance: Map<string, { incidentId: string; endsAtMs: number }>
): PublicComponent | { reason: string } {
  const { component } = runtime;
  const { name, description } = text;

  let vendor: PublicComponent['vendor'] = null;
  let automatic = runtime.automaticState;
  if (component.monitoring === 'vendor') {
    if (!component.vendor || !component.vendor.publicNaming) return { reason: 'vendor_not_public' };
    const feed = runtime.vendorFeed ?? null;
    automatic = vendorIndicatorToState(feed?.indicator);
    vendor = {
      statusPageUrl: component.vendor.statusPageUrl,
      upstream: feed ? { indicator: feed.indicator, checkedAt: iso(feed.checkedAt) } : null,
    };
  }

  const base = displayedBaseState({ automatic, pin: runtime.activePin, suppressed: runtime.suppressed });
  const impacts = activeImpacts.get(component.key) ?? [];
  const state = displayedState(base, impacts);
  const mine = maintenance.get(component.key);
  const autoDetected =
    component.monitoring === 'probed' &&
    (automatic === 'partial_outage' || automatic === 'major_outage') &&
    base === automatic &&
    impacts.length === 0;

  const row = {
    slug: component.publicSlug,
    name,
    group: component.group,
    order: component.order,
    description,
    state,
    baseState: base,
    monitoring: component.monitoring,
    autoDetected,
    externallyMonitored: component.externallyMonitored,
    maintenance: mine ? { incidentId: mine.incidentId, endsAt: iso(new Date(mine.endsAtMs)) } : null,
    children: [],
    vendor,
  };
  const parsed = PublicComponentSchema.safeParse(row);
  return parsed.success ? parsed.data : { reason: 'schema' };
}

function projectUpdate(
  update: StatusIncidentUpdateDoc,
  linkOptions: LinkPolicyOptions,
  truncatedIds: string[]
): PublicUpdate | { reason: string } {
  const checked = validatePublicText('updateBody', update.body, linkOptions);
  const overLimit = lengthOnly(checked);
  if (!checked.ok && !overLimit) return { reason: 'text_policy' };
  const prefix = overLimit
    ? checked.normalized.slice(0, TEXT_LIMITS.updateBody * 4).replace(/[\uD800-\uDBFF]$/, '')
    : checked.normalized;
  const sanitized = overLimit || checked.stored === undefined ? sanitizeMarkdown(prefix, linkOptions) : checked.stored;
  const fitted = truncateToSchemaCap(sanitized, TEXT_LIMITS.updateBody);
  const truncated = fitted.truncated || prefix.length < checked.normalized.length;
  if (overLimit) {
    const recheck = validatePublicText('updateBody', fitted.text, linkOptions);
    if (!recheck.ok && !lengthOnly(recheck)) return { reason: 'text_policy' };
  }
  if (truncated) truncatedIds.push(update.updateId);
  return {
    id: update.updateId,
    at: iso(update.at),
    status: update.status,
    body: fitted.text,
    edited: update.editedAt !== undefined,
    truncated,
  };
}

function projectIncident(
  doc: StatusIncidentDoc,
  slugByKey: Map<string, string>,
  linkOptions: LinkPolicyOptions,
  now: Date,
  sink: DropSink
): IncidentProjection | { reason: string } {
  const title = validatePublicText('title', doc.title, linkOptions);
  if (!title.ok) return { reason: 'text_policy' };
  if (doc.updates.length > MAX_INCIDENT_UPDATES) return { reason: 'too_many_updates' };

  const updates: PublicUpdate[] = [];
  const truncatedIds: string[] = [];
  for (const update of [...doc.updates].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const projected = projectUpdate(update, linkOptions, truncatedIds);
    if ('reason' in projected) return projected;
    updates.push(projected);
  }
  if (truncatedIds.length > 0) sink.warnings.push(`update_body_truncated_${doc.publicId}`);

  let postmortem: PublicIncidentDetail['postmortem'] = null;
  const postmortemParts: string[] = [];
  if (doc.postmortem?.publishedAt && (doc.postmortem.url || doc.postmortem.body)) {
    let body: string | null = null;
    if (doc.postmortem.body) {
      const checked = validatePublicText('postmortemBody', doc.postmortem.body, linkOptions);
      if (!checked.ok && !lengthOnly(checked)) return { reason: 'text_policy' };
      const stored = checked.ok ? (checked.stored ?? sanitizeMarkdown(checked.normalized, linkOptions)) : null;
      if (stored !== null && stored.length <= TEXT_LIMITS.postmortemBody) {
        body = stored;
        postmortemParts.push(body);
      } else {
        sink.dropped.push({ file: 'incident', ref: doc.publicId, reason: 'postmortem_body_too_long' });
      }
    }
    const link = doc.postmortem.url ? classifyLink(doc.postmortem.url, linkOptions) : null;
    const url = link && link.allowed && link.href.startsWith('https:') ? link.href : null;
    if (url !== null || body !== null) postmortem = { url, body, publishedAt: iso(doc.postmortem.publishedAt) };
  }

  if (
    incidentPublicTextLength([title.normalized, ...updates.map(u => u.body), ...postmortemParts]) >
    TEXT_LIMITS.incidentPublicText
  ) {
    return { reason: 'text_budget' };
  }

  const components = doc.components.flatMap(listed => {
    const slug = slugByKey.get(listed.componentKey);
    return slug ? [{ slug, impact: listed.impact }] : [];
  });

  const scalars = {
    id: doc.publicId,
    kind: doc.kind,
    title: title.normalized.trim(),
    status: doc.status,
    impact: doc.impact,
    components,
    startedAt: iso(doc.startedAt),
    resolvedAt: isoOrNull(doc.resolvedAt),
    scheduledStartAt: isoOrNull(doc.scheduledStartAt),
    scheduledEndAt: isoOrNull(doc.scheduledEndAt),
    completedEarlyAt: isoOrNull(doc.completedEarlyAt),
    updatedAt: iso(doc.updatedAt),
    updateCount: updates.length,
  };

  const latestUpdates = [...updates]
    .reverse()
    .slice(0, SUMMARY_LATEST_UPDATES)
    .map(update => {
      const cut = truncateToSchemaCap(update.body, TEXT_LIMITS.summaryUpdateBody);
      return cut.truncated ? { ...update, body: cut.text, truncated: true } : update;
    });

  const head = PublicIncidentHeadSchema.safeParse({ ...scalars, latestUpdates });
  const detail = PublicIncidentDetailSchema.safeParse({
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: iso(now),
    incident: { ...scalars, updates },
    postmortem,
  });
  const row = PublicIncidentsIndexSchema.shape.incidents.element.safeParse(scalars);
  if (!head.success || !detail.success || !row.success) return { reason: 'schema' };
  return { doc, head: head.data, detail: detail.data, row: row.data };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function projectUptime(
  input: ProjectionInput,
  publicRuntimes: readonly StatusComponentRuntime[],
  slugByKey: Map<string, string>,
  publishedIds: Set<string>,
  sink: DropSink
): PublicUptime {
  const { dropped, warnings } = sink;
  const eligibleKeys = new Set(
    publicRuntimes.filter(({ component }) => component.monitoring === 'probed').map(({ component }) => component.key)
  );
  const today = input.now.getTime();
  const windowFirst = utcDay(today - (STATUS_UPTIME_WINDOW_DAYS - 1) * DAY_MS);
  const windowLast = utcDay(today);
  type Component = PublicUptime['components'][number];
  type Tuple = Component['days'][number];
  const accepted: { component: Component; days: Map<string, Tuple> }[] = [];
  let from: string | null = null;
  let to: string | null = null;

  const acceptRow = (row: UptimeComponentInput, slug: string): void => {
    const validDays =
      Array.isArray(row.days) && row.days.every(day => PublicUptimeSchema.shape.from.safeParse(day.day).success);
    const uniqueDays = validDays && new Set(row.days.map(day => day.day)).size === row.days.length;
    if (!validDays || !uniqueDays || (row.uptime !== null && !Number.isFinite(row.uptime))) {
      dropped.push({ file: 'uptime', ref: row.componentKey, reason: 'schema' });
      return;
    }
    const observations: UptimeComponentInput['days'][number][] = [];
    const tuples: unknown[][] = [];
    const inWindow = row.days
      .filter(day => day.day >= windowFirst && day.day <= windowLast)
      .sort((a, b) => cmpStr(a.day, b.day));
    for (const day of inWindow) {
      try {
        tuples.push([
          day.barCode,
          day.uptimeBp,
          Math.round(day.downtimeMinutes),
          new Set(day.incidentIds.filter(id => publishedIds.has(id))).size,
        ]);
        observations.push(day);
      } catch (error) {
        dropped.push({ file: 'uptime', ref: row.componentKey, reason: dropReason(error) });
      }
    }
    const parsed = PublicUptimeSchema.shape.components.element.safeParse({
      slug,
      uptime: floorUptimeFraction(row.uptime),
      days: tuples,
    });
    if (!parsed.success) {
      dropped.push({ file: 'uptime', ref: row.componentKey, reason: 'schema' });
      return;
    }
    const days = new Map<string, Tuple>();
    observations.forEach((day, index) => {
      days.set(day.day, parsed.data.days[index]);
      if (from === null || day.day < from) from = day.day;
      if (to === null || day.day > to) to = day.day;
    });
    accepted.push({ component: parsed.data, days });
  };

  for (const row of input.uptime ?? []) {
    try {
      const slug = slugByKey.get(row.componentKey);
      if (!slug || !eligibleKeys.has(row.componentKey)) continue;
      acceptRow(row, slug);
    } catch (error) {
      dropped.push({ file: 'uptime', ref: refOf(row?.componentKey), reason: dropReason(error) });
    }
  }
  const first = from ?? windowFirst;
  const last = to ?? windowLast;
  const calendar: string[] = [];
  for (let time = Date.parse(`${first}T00:00:00Z`); time <= Date.parse(`${last}T00:00:00Z`); time += DAY_MS) {
    calendar.push(utcDay(time));
  }
  const components = accepted
    .map(({ component, days }) => ({
      ...component,
      days: calendar.map<Tuple>(day => days.get(day) ?? ['n', null, 0, 0]),
    }))
    .sort((a, b) => cmpStr(a.slug, b.slug));
  const candidate = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAt: iso(input.now),
    from: first,
    to: last,
    components,
  };
  const parsed = PublicUptimeSchema.safeParse(candidate);
  if (!parsed.success) {
    dropped.push({ file: 'uptime', ref: 'uptime', reason: 'schema' });
    return PublicUptimeSchema.parse({ ...candidate, components: [] });
  }
  if (!checkFileSize('uptime', JSON.stringify(parsed.data)).withinCap) warnings.push('uptime_over_cap');
  return parsed.data;
}
