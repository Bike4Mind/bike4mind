import { z } from 'zod';
import { cmpStr, cmpTime } from './compare';
import { isActive, maintenanceEffectiveEndMs, toEpochMs, type ActivityFacts } from './isActive';
import {
  LenientPublicBreakglassSchema,
  LenientPublicIncidentsIndexSchema,
  parsePublicFile,
  type PublicBreakglass,
  type PublicBreakglassEntry,
  type PublicComponent,
  type PublicExternal,
  type PublicFileKind,
  type PublicIncidentHead,
  type PublicIncidentIndexRow,
  type PublicIncidentsIndex,
  type PublicSummary,
  type PublicUpdate,
  type ParsedPublicFile,
} from './schemas.public';
import { uncoveredIncidentState, worstImpact, worstState, type ComponentImpact, type DisplayState } from './stateOrder';

export const EXTERNAL_MAX_AGE_SECONDS = 180;
const BREAKGLASS_BACKWARD_MS = 15 * 60 * 1000;
const BREAKGLASS_FORWARD_MS = 60 * 1000;
// Clock skew allowed before a timestamp in the future stops counting as recent.
const FUTURE_TOLERANCE_MS = 60 * 1000;
const BREAKGLASS_START_FLOOR_MS = 24 * 60 * 60 * 1000;
const EXTERNAL_OVERRIDE_MAX_MS = 24 * 60 * 60 * 1000;
const BREAKGLASS_SCHEDULE_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

export type SourceFailureReason = 'absent' | 'http' | 'not_json' | 'schema';
export type SourceResult<K extends PublicFileKind> =
  | (Extract<ParsedPublicFile<K>, { ok: true }> & {
      /** Break-glass entries that failed their own parse and were left out; 0 for every other file. */
      droppedEntries: number;
    })
  | { ok: false; reason: SourceFailureReason };

const BreakglassEnvelopeSchema = LenientPublicBreakglassSchema.extend({ entries: z.array(z.unknown()) });
const BreakglassEntrySchema = LenientPublicBreakglassSchema.shape.entries.element;

/**
 * Classifies a fetched file: absent, non-2xx, not JSON, or failing the lenient schema. A break-glass
 * file keeps its good entries when others fail: the envelope is validated, then each entry on its own.
 */
export function parseSourceFile<K extends PublicFileKind>(
  kind: K,
  response: { status: number; body: string } | null | undefined
): SourceResult<K> {
  if (!response) return { ok: false, reason: 'absent' };
  if (response.status < 200 || response.status > 299) return { ok: false, reason: 'http' };
  let json: unknown;
  try {
    json = JSON.parse(response.body);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (kind === 'breakglass') {
    const envelope = BreakglassEnvelopeSchema.safeParse(json);
    if (!envelope.success) return { ok: false, reason: 'schema' };
    const entries = envelope.data.entries.flatMap(entry => {
      const parsed = BreakglassEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    const data = { ...envelope.data, entries } as PublicBreakglass;
    return { ok: true, data, droppedEntries: envelope.data.entries.length - entries.length } as SourceResult<K>;
  }
  const parsed = parsePublicFile(kind, json, 'lenient');
  return parsed.ok ? ({ ...parsed, droppedEntries: 0 } as SourceResult<K>) : { ok: false, reason: 'schema' };
}

export interface MergeOptions {
  /** Complete incidents.json envelope, including its shared publish revision. */
  incidentsIndex?: PublicIncidentsIndex | null;
  /** The last good summary kept locally, shown greyed with its age when the live one fails. */
  lastGoodSummary?: { summary: PublicSummary; savedAt: string } | null;
}

export type MergeMode = 'unavailable' | 'fresh' | 'stale' | 'hard_stale';

export type MergedHeadline =
  | { kind: 'unavailable'; state: 'unknown'; text: 'Status data unavailable' }
  | { kind: 'delayed'; state: 'unknown'; text: string; lastConfirmedAt: string }
  | { kind: 'maintenance'; state: DisplayState; text: 'Maintenance in progress' }
  | { kind: 'state'; state: DisplayState; text: null };

export type MergedComponent = Omit<PublicComponent, 'children'> & {
  /** Set when the summary is stale: the state shown is the last known one as of this time. */
  staleAsOf: string | null;
  children: (Omit<PublicComponent['children'][number], never> & { staleAsOf: string | null })[];
};

export interface MergedIncident extends Omit<PublicIncidentHead, 'latestUpdates'> {
  updates: PublicUpdate[];
  active: boolean;
  /** Only from break-glass entries above the applied seq. */
  unreconciled: boolean;
}

export interface MergedStatus {
  mode: MergeMode;
  fresh: boolean;
  hardStale: boolean;
  ageSeconds: number | null;
  headline: MergedHeadline;
  notice: PublicSummary['overall']['notice'];
  components: MergedComponent[];
  incidents: MergedIncident[];
  external: { state: PublicExternal['state']; checkedAt: string; since: string } | null;
  lastKnown: { summary: PublicSummary; savedAt: string; ageSeconds: number } | null;
}

interface Candidate {
  origin: 'summary' | 'index' | 'breakglass';
  scalars: Omit<PublicIncidentHead, 'latestUpdates'>;
  updates: (PublicUpdate & { editedAt?: string | null })[];
}

function ms(value: string): number {
  return Date.parse(value);
}

function iso(valueMs: number): string {
  return new Date(valueMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function headScalars(head: Omit<PublicIncidentHead, 'latestUpdates'> & { latestUpdates?: unknown }) {
  const { latestUpdates: _latest, ...scalars } = head;
  return scalars as Omit<PublicIncidentHead, 'latestUpdates'>;
}

/**
 * Applies the same timestamp rules reconcile uses to an unreconciled break-glass entry, so the page
 * never shows a less constrained entry than reconcile would accept. W is the CLI-stamped updatedAt.
 */
export function clampBreakGlassEntry(
  entry: PublicBreakglassEntry,
  context: { nowMs: number; outageStartMs: number | null }
): PublicBreakglassEntry | null {
  const written = ms(entry.updatedAt);
  if (!Number.isFinite(written) || !Number.isFinite(ms(entry.startedAt))) return null;
  const lower = written - BREAKGLASS_BACKWARD_MS;
  const upper = Math.min(written + BREAKGLASS_FORWARD_MS, context.nowMs + BREAKGLASS_FORWARD_MS);
  const within = (value: number) => Math.min(Math.max(value, lower), upper);
  const scheduleUpper = context.nowMs + BREAKGLASS_SCHEDULE_MAX_AHEAD_MS;
  const outageStart = context.outageStartMs ?? written;
  const startFloor = Math.max(written - BREAKGLASS_START_FLOOR_MS, outageStart - BREAKGLASS_BACKWARD_MS);

  // Optional timestamps keep their null; an unparseable one rejects the entry like an unparseable `at`.
  const capped = (value: string | null, cap: number): string | null | undefined => {
    if (value === null) return null;
    const parsed = ms(value);
    return Number.isFinite(parsed) ? iso(Math.min(parsed, cap)) : undefined;
  };
  const resolvedAt = capped(entry.resolvedAt, upper);
  const completedEarlyAt = capped(entry.completedEarlyAt, upper);
  const scheduledStartAt = capped(entry.scheduledStartAt, scheduleUpper);
  const scheduledEndAt = capped(entry.scheduledEndAt, scheduleUpper);
  if ([resolvedAt, completedEarlyAt, scheduledStartAt, scheduledEndAt].includes(undefined)) return null;

  const latestUpdates = [];
  for (const update of entry.latestUpdates) {
    const at = ms(update.at);
    if (!Number.isFinite(at)) return null;
    const clamped = { ...update, at: iso(within(at)) };
    if (update.editedAt) {
      const editedAt = ms(update.editedAt);
      if (!Number.isFinite(editedAt)) return null;
      clamped.editedAt = iso(within(editedAt));
    }
    latestUpdates.push(clamped);
  }
  return {
    ...entry,
    updatedAt: iso(within(written)),
    startedAt: iso(Math.min(Math.max(ms(entry.startedAt), startFloor), upper)),
    resolvedAt: resolvedAt as string | null,
    completedEarlyAt: completedEarlyAt as string | null,
    scheduledStartAt: scheduledStartAt as string | null,
    scheduledEndAt: scheduledEndAt as string | null,
    latestUpdates,
  };
}

type UpdateWithEdit = PublicUpdate & { editedAt?: string | null };
type UpdateEntry = { update: UpdateWithEdit; incidentUpdatedAt: number; rank: number };

const ORIGIN_RANK: Record<Candidate['origin'], number> = { summary: 0, index: 1, breakglass: 2 };

// Later (editedAt ?? at) wins, then the newer incident, then the more trusted source, so the order
// the sources are listed in never changes the result.
function pickUpdate(current: UpdateEntry, next: UpdateEntry): UpdateEntry {
  const a = ms(current.update.editedAt ?? current.update.at);
  const b = ms(next.update.editedAt ?? next.update.at);
  if (a !== b && Number.isFinite(a) && Number.isFinite(b)) return b > a ? next : current;
  if (next.incidentUpdatedAt !== current.incidentUpdatedAt) {
    return next.incidentUpdatedAt > current.incidentUpdatedAt ? next : current;
  }
  if (next.rank !== current.rank) return next.rank < current.rank ? next : current;
  return cmpStr(next.update.body, current.update.body) < 0 ? next : current;
}

function activityOf(incident: Omit<PublicIncidentHead, 'latestUpdates'>): ActivityFacts {
  return {
    kind: incident.kind,
    published: true,
    retracted: false,
    status: incident.status,
    resolvedAt: incident.resolvedAt,
    scheduledStartAt: incident.scheduledStartAt,
    scheduledEndAt: incident.scheduledEndAt,
    completedEarlyAt: incident.completedEarlyAt,
  };
}

function currentIndex(summary: PublicSummary | null, index: PublicIncidentsIndex | null, nowMs: number): boolean {
  if (!summary || !index || index.seq < summary.seq) return false;
  if (ms(index.generatedAt) > nowMs + FUTURE_TOLERANCE_MS) return false;
  const rows = new Map(index.incidents.map(row => [row.id, row]));
  if (rows.size !== index.incidents.length) return false;
  if (index.seq > summary.seq) return true;
  return [...summary.activeIncidents, ...summary.upcomingMaintenance].every(head => {
    const parsed = LenientPublicIncidentsIndexSchema.shape.incidents.element.safeParse(headScalars(head));
    return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(rows.get(head.id));
  });
}

function historicalRow(row: PublicIncidentIndexRow, nowMs: number): boolean {
  if (isActive(activityOf(row), nowMs)) return false;
  if (row.kind === 'incident' || row.status === 'cancelled') return true;
  const end = maintenanceEffectiveEndMs(row);
  return end !== null && end <= nowMs;
}

/**
 * One merge for the page, the in-app banner, the admin preview and tests. `S` is the summary or null
 * when it failed (non-2xx, non-JSON, schema failure, absent).
 */
export function mergeStatusSources(
  S: PublicSummary | null,
  B: PublicBreakglass | null,
  E: PublicExternal | null,
  serverNow: Date | number,
  options: MergeOptions = {}
): MergedStatus {
  const nowMs = typeof serverNow === 'number' ? serverNow : serverNow.getTime();

  const ageSeconds = S ? (nowMs - ms(S.probesAsOf)) / 1000 : null;
  const fresh =
    S !== null && ageSeconds !== null && ageSeconds >= -FUTURE_TOLERANCE_MS / 1000 && ageSeconds <= S.staleAfterSeconds;
  const futureDated = ageSeconds !== null && ageSeconds < -FUTURE_TOLERANCE_MS / 1000;
  const hardStale = S !== null && ageSeconds !== null && ageSeconds > S.hardStaleAfterSeconds;
  const mode: MergeMode = !S ? 'unavailable' : hardStale ? 'hard_stale' : fresh ? 'fresh' : 'stale';

  const appliedSeq = S ? S.breakglassAppliedSeq : Number.NEGATIVE_INFINITY;
  const writtenAt = B ? ms(B.updatedAt) : Number.NaN;
  const overrideLatest = (Number.isFinite(writtenAt) ? Math.min(writtenAt, nowMs) : nowMs) + EXTERNAL_OVERRIDE_MAX_MS;
  const externalOverrideActive =
    !!B?.externalOverride &&
    B.externalOverride.writtenSeq > appliedSeq &&
    nowMs < Math.min(ms(B.externalOverride.ignoreUntil), overrideLatest);
  const externalUsable =
    !!E &&
    nowMs - ms(E.checkedAt) >= -FUTURE_TOLERANCE_MS &&
    nowMs - ms(E.checkedAt) <= EXTERNAL_MAX_AGE_SECONDS * 1000 &&
    !(S?.externalIgnoredUntil && nowMs < ms(S.externalIgnoredUntil)) &&
    !externalOverrideActive;

  const outageCandidates: number[] = [];
  if (S && !fresh && !futureDated) outageCandidates.push(ms(S.probesAsOf));
  if (E && E.state === 'down') outageCandidates.push(ms(E.since));
  const parseable = outageCandidates.filter(Number.isFinite);
  const outageStartMs = parseable.length > 0 ? Math.min(...parseable) : null;

  const parsedIndex = options.incidentsIndex
    ? LenientPublicIncidentsIndexSchema.safeParse(options.incidentsIndex)
    : null;
  const index = parsedIndex?.success ? parsedIndex.data : null;
  const trustedIndex = currentIndex(S, index, nowMs);
  const heads = [...(S?.activeIncidents ?? []), ...(S?.upcomingMaintenance ?? [])];
  const breakglassCandidates: Candidate[] = [];
  const unreconciled = new Set<string>();
  for (const entry of B?.entries ?? []) {
    if (entry.writtenSeq <= appliedSeq) continue;
    const clamped = clampBreakGlassEntry(entry, { nowMs, outageStartMs });
    if (!clamped) continue;
    unreconciled.add(clamped.id);
    breakglassCandidates.push({ origin: 'breakglass', scalars: headScalars(clamped), updates: clamped.latestUpdates });
  }
  const protectedIds = new Set([
    ...heads.map(head => head.id),
    ...breakglassCandidates.map(candidate => candidate.scalars.id),
  ]);
  const candidates: Candidate[] = heads.map(head => ({
    origin: 'summary',
    scalars: headScalars(head),
    updates: head.latestUpdates,
  }));
  for (const row of index?.incidents ?? []) {
    if (!trustedIndex && (protectedIds.has(row.id) || !historicalRow(row, nowMs))) continue;
    candidates.push({ origin: 'index', scalars: row, updates: [] });
  }
  candidates.push(...breakglassCandidates);

  const byId = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    byId.set(candidate.scalars.id, [...(byId.get(candidate.scalars.id) ?? []), candidate]);
  }

  const incidents: MergedIncident[] = [];
  for (const [id, group] of byId) {
    // A complete current index owns normal scalars; older summary bodies can still fill updates.
    const scalarCandidates = trustedIndex ? group.filter(candidate => candidate.origin !== 'summary') : group;
    let winner = scalarCandidates[0];
    if (!winner) continue;
    for (const candidate of scalarCandidates.slice(1)) {
      if (ms(candidate.scalars.updatedAt) > ms(winner.scalars.updatedAt)) winner = candidate;
    }
    const updates = new Map<string, UpdateEntry>();
    for (const candidate of group) {
      for (const update of candidate.updates) {
        const entry = {
          update,
          incidentUpdatedAt: ms(candidate.scalars.updatedAt),
          rank: ORIGIN_RANK[candidate.origin],
        };
        const existing = updates.get(update.id);
        updates.set(update.id, existing ? pickUpdate(existing, entry) : entry);
      }
    }
    const merged = [...updates.values()]
      .map(({ update }) => {
        const { editedAt: _editedAt, ...publicUpdate } = update;
        return publicUpdate;
      })
      .sort((a, b) => cmpTime(b.at, a.at) || cmpStr(a.id, b.id));
    incidents.push({
      ...winner.scalars,
      updateCount: Math.max(winner.scalars.updateCount, merged.length),
      updates: merged,
      active: isActive(activityOf(winner.scalars), nowMs),
      unreconciled: unreconciled.has(id) && winner.origin === 'breakglass',
    });
  }
  incidents.sort((a, b) => cmpTime(b.updatedAt, a.updatedAt) || cmpStr(a.id, b.id));

  const activeImpacts = new Map<string, ComponentImpact[]>();
  const activeMaintenance = new Map<string, { incidentId: string; endsAt: string; startMs: number }>();
  for (const incident of incidents) {
    if (!incident.active) continue;
    for (const listed of incident.components) {
      if (incident.kind === 'incident') {
        activeImpacts.set(listed.slug, [...(activeImpacts.get(listed.slug) ?? []), listed.impact]);
      } else {
        const end = maintenanceEffectiveEndMs(incident);
        const start = toEpochMs(incident.scheduledStartAt);
        const current = activeMaintenance.get(listed.slug);
        if (end !== null && start !== null && (!current || start < current.startMs)) {
          activeMaintenance.set(listed.slug, { incidentId: incident.id, endsAt: iso(end), startMs: start });
        }
      }
    }
  }

  // Past the size ladder's last step the summary no longer lists every active head; with no index to
  // fill them in, its own computed state is the floor.
  const floorToSummary = S !== null && !hardStale && S.moreActiveIncidents > 0 && !trustedIndex;
  const externalDown = fresh === false && externalUsable && E?.state === 'down';
  const resolveRow = <R extends Omit<PublicComponent, 'children' | 'group'>>(row: R) => {
    let base: DisplayState = hardStale && row.monitoring === 'probed' ? 'unknown' : row.baseState;
    if (externalDown && row.externallyMonitored) base = worstState([base, 'major_outage']);
    const impacts = activeImpacts.get(row.slug) ?? [];
    const worst = worstImpact(impacts);
    const computed = worst ? worstState([base, worst]) : base;
    const state = floorToSummary ? worstState([computed, row.state]) : computed;
    const maintenance = activeMaintenance.get(row.slug);
    return {
      ...row,
      baseState: base,
      state,
      maintenance: maintenance
        ? { incidentId: maintenance.incidentId, endsAt: maintenance.endsAt }
        : floorToSummary
          ? row.maintenance
          : null,
      staleAsOf: S && !fresh && !futureDated ? S.probesAsOf : null,
    };
  };

  const components = (S?.components ?? []).map(row => ({
    ...resolveRow(row),
    group: row.group,
    children: row.children.map(child => resolveRow(child)),
  })) as MergedComponent[];

  const visibleStates = components.flatMap(row => [row, ...row.children]);
  let headline: MergedHeadline;
  if (!S) {
    headline = { kind: 'unavailable', state: 'unknown', text: 'Status data unavailable' };
  } else if (!fresh) {
    headline = {
      kind: 'delayed',
      state: 'unknown',
      text: `Live status delayed, last confirmed ${S.probesAsOf}`,
      lastConfirmedAt: S.probesAsOf,
    };
  } else {
    const pageSlugs = new Set(visibleStates.map(row => row.slug));
    const uncovered = uncoveredIncidentState(
      incidents.filter(incident => incident.active),
      pageSlugs
    );
    const rowsState = worstState(visibleStates.map(row => row.state));
    const state = worstState([rowsState, uncovered, floorToSummary ? S.overall.state : null]);
    const degraded = visibleStates.filter(row => row.state !== 'operational');
    headline =
      degraded.length > 0 &&
      degraded.every(row => row.maintenance !== null) &&
      (uncovered === null || uncovered === 'operational') &&
      state === rowsState
        ? { kind: 'maintenance', state, text: 'Maintenance in progress' }
        : { kind: 'state', state, text: null };
  }

  let lastKnown: MergedStatus['lastKnown'] = null;
  if (!S && options.lastGoodSummary) {
    const savedMs = ms(options.lastGoodSummary.savedAt);
    if (Number.isFinite(savedMs)) {
      lastKnown = { ...options.lastGoodSummary, ageSeconds: Math.max(0, (nowMs - savedMs) / 1000) };
    }
  }

  return {
    mode,
    fresh,
    hardStale,
    ageSeconds,
    headline,
    notice: S?.overall.notice ?? null,
    components,
    incidents,
    external: externalUsable && E ? { state: E.state, checkedAt: E.checkedAt, since: E.since } : null,
    lastKnown,
  };
}
