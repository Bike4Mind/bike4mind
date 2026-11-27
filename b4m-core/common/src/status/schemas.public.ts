import { z } from 'zod';
import { ALL_INCIDENT_STATUSES, INCIDENT_KINDS, INCIDENT_STATUSES, MAINTENANCE_STATUSES } from './isActive';
import { isHttpsUrl } from './linkPolicy';
import { BAR_CODES } from './uptimeDisplay';
import { COMPONENT_IMPACTS, DISPLAY_STATES, OVERALL_IMPACTS, VENDOR_INDICATORS } from './stateOrder';
import {
  COMPONENT_MONITORING,
  JOURNAL_NONCE_PATTERN,
  PROBES_TRIGGERS,
  PUBLIC_INCIDENT_ID_PATTERN,
  PUBLIC_SLUG_PATTERN,
  PUBLIC_UPDATE_ID_PATTERN,
  STATUS_SCHEMA_VERSION,
  STATUS_UPTIME_WINDOW_DAYS,
  TEXT_LIMITS,
} from './types';

export const SUPPORT_EMAIL_MAX_LENGTH = 254;
export const SUPPORT_EMAIL_PATTERN = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

export type PublicSchemaMode = 'strict' | 'lenient';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CalendarTimestampSchema = z.iso.datetime();
const CalendarDaySchema = z.iso.date();

/**
 * Strict schemas reject unknown keys at every depth and are used by publishers and tests. Lenient
 * schemas have the same shape and strip unknown keys, because page JS and data deploy independently.
 */
function buildPublicSchemas(mode: PublicSchemaMode) {
  const obj = <S extends z.ZodRawShape>(shape: S): z.ZodObject<S, z.core.$strict> =>
    (mode === 'strict' ? z.strictObject(shape) : z.object(shape)) as unknown as z.ZodObject<S, z.core.$strict>;

  const timestamp = z
    .string()
    .regex(ISO_TIMESTAMP)
    .refine(value => CalendarTimestampSchema.safeParse(value).success, 'must be a real calendar time');
  const day = z
    .string()
    .regex(ISO_DAY)
    .refine(value => CalendarDaySchema.safeParse(value).success, 'must be a real calendar day');
  const nullableTimestamp = timestamp.nullable();
  const httpsUrl = z.string().max(2048).refine(isHttpsUrl, 'must be an https URL');
  const incidentId = z.string().regex(PUBLIC_INCIDENT_ID_PATTERN);
  const slug = z.string().regex(PUBLIC_SLUG_PATTERN);
  const count = z.number().int().nonnegative();

  const componentState = z.enum(DISPLAY_STATES);
  const componentImpact = z.enum(COMPONENT_IMPACTS);
  const incidentStatus = z.enum(ALL_INCIDENT_STATUSES);

  const incidentComponent = obj({ slug, impact: componentImpact });

  // Incidents run investigating to resolved; maintenance is scheduled, completed or cancelled.
  const statusMatchesKind = (value: { kind: string; status: string }) =>
    (value.kind === 'incident'
      ? (INCIDENT_STATUSES as readonly string[])
      : (MAINTENANCE_STATUSES as readonly string[])
    ).includes(value.status);
  const kindStatus = <S extends z.ZodType<{ kind: string; status: string }>>(schema: S): S =>
    schema.refine(statusMatchesKind, { message: 'status does not belong to this kind', path: ['status'] });

  const update = (bodyMax: number) =>
    obj({
      id: z.string().regex(PUBLIC_UPDATE_ID_PATTERN),
      at: timestamp,
      status: incidentStatus,
      body: z.string().max(bodyMax),
      edited: z.boolean(),
      truncated: z.boolean(),
    });

  const headScalars = {
    id: incidentId,
    kind: z.enum(INCIDENT_KINDS),
    title: z.string().min(1).max(TEXT_LIMITS.title),
    status: incidentStatus,
    impact: z.enum(OVERALL_IMPACTS),
    components: z.array(incidentComponent),
    startedAt: timestamp,
    resolvedAt: nullableTimestamp,
    scheduledStartAt: nullableTimestamp,
    scheduledEndAt: nullableTimestamp,
    completedEarlyAt: nullableTimestamp,
    updatedAt: timestamp,
    updateCount: count,
  };

  const incidentHead = kindStatus(
    obj({
      ...headScalars,
      latestUpdates: z.array(update(TEXT_LIMITS.summaryUpdateBody)),
    })
  );

  const componentRowShape = {
    slug,
    name: z.string().min(1).max(TEXT_LIMITS.title),
    order: z.number().int(),
    description: z.string().max(TEXT_LIMITS.componentDescription).nullable().optional(),
    state: componentState,
    baseState: componentState,
    monitoring: z.enum(COMPONENT_MONITORING),
    autoDetected: z.boolean(),
    externallyMonitored: z.boolean(),
    maintenance: obj({ incidentId, endsAt: timestamp }).nullable(),
    vendor: obj({
      statusPageUrl: httpsUrl,
      upstream: obj({ indicator: z.enum(VENDOR_INDICATORS), checkedAt: timestamp }).nullable(),
    }).nullable(),
  };

  const childComponent = obj(componentRowShape);
  const component = obj({
    ...componentRowShape,
    group: slug,
    children: z.array(childComponent),
  });

  const probesTrigger = z.enum(PROBES_TRIGGERS).nullable();

  const summary = obj({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    seq: count,
    generatedAt: timestamp,
    probesAsOf: timestamp,
    probesTrigger: mode === 'strict' ? probesTrigger : probesTrigger.default(null),
    staleAfterSeconds: z.number().int().positive(),
    hardStaleAfterSeconds: z.number().int().positive(),
    breakglassAppliedSeq: count,
    externalIgnoredUntil: nullableTimestamp,
    page: obj({
      title: z.string().min(1).max(TEXT_LIMITS.title),
      appUrl: httpsUrl,
      linkHosts: z.array(z.string().min(1).max(253)).max(200),
      supportEmail: z.string().max(SUPPORT_EMAIL_MAX_LENGTH).regex(SUPPORT_EMAIL_PATTERN).nullable().default(null),
    }),
    overall: obj({ state: componentState, notice: z.literal('offline').nullable() }),
    groups: z.array(obj({ slug, name: z.string().min(1).max(TEXT_LIMITS.title), order: z.number().int() })),
    components: z.array(component),
    activeIncidents: z.array(incidentHead),
    upcomingMaintenance: z.array(incidentHead),
    moreActiveIncidents: count,
  });

  const postmortem = obj({
    url: httpsUrl.nullable(),
    body: z.string().max(TEXT_LIMITS.postmortemBody).nullable(),
    publishedAt: nullableTimestamp,
  });

  const incidentDetail = obj({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    generatedAt: timestamp,
    incident: kindStatus(obj({ ...headScalars, updates: z.array(update(TEXT_LIMITS.updateBody)) })),
    postmortem: postmortem.nullable(),
  });

  const indexRow = kindStatus(obj(headScalars));

  const incidentsIndex = obj({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    seq: count,
    generatedAt: timestamp,
    windowDays: z.literal(STATUS_UPTIME_WINDOW_DAYS),
    incidents: z.array(indexRow),
  });

  const archive = obj({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    year: z.number().int().min(2000).max(9999),
    incidents: z.array(indexRow),
  });

  const dayTuple = z.tuple([
    z.enum(BAR_CODES),
    z.number().int().min(0).max(10_000).nullable(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]);

  const uptime = obj({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    generatedAt: timestamp,
    from: day,
    to: day,
    components: z.array(obj({ slug, uptime: z.number().min(0).max(1).nullable(), days: z.array(dayTuple) })),
  });

  const breakglassUpdate = obj({
    id: z.string().regex(PUBLIC_UPDATE_ID_PATTERN),
    at: timestamp,
    status: incidentStatus,
    body: z.string().max(TEXT_LIMITS.updateBody),
    edited: z.boolean(),
    truncated: z.boolean(),
    editedAt: nullableTimestamp.optional(),
  });

  const breakglass = obj({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    seq: count,
    updatedAt: timestamp,
    entries: z.array(
      kindStatus(
        obj({
          ...headScalars,
          latestUpdates: z.array(breakglassUpdate),
          writtenSeq: count,
          // Only the random part of the private journal key: the full key names the writer.
          journalNonce: z.string().regex(JOURNAL_NONCE_PATTERN),
        })
      )
    ),
    externalOverride: obj({ writtenSeq: count, ignoreUntil: timestamp }).nullable(),
  });

  const external = obj({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    seq: count,
    state: z.enum(['up', 'down', 'unknown']),
    since: timestamp,
    checkedAt: timestamp,
  });

  const statusJson = obj({
    page: obj({ name: z.string().max(TEXT_LIMITS.title), url: httpsUrl, updated_at: timestamp }),
    status: obj({ indicator: z.enum(OVERALL_IMPACTS), description: z.string().max(200) }),
  });

  return {
    summary,
    incidentDetail,
    incidentsIndex,
    archive,
    uptime,
    breakglass,
    external,
    statusJson,
    incidentHead,
    component,
    update: update(TEXT_LIMITS.updateBody),
  };
}

const strict = buildPublicSchemas('strict');
const lenient = buildPublicSchemas('lenient');

export const PublicSummarySchema = strict.summary;
export const PublicIncidentDetailSchema = strict.incidentDetail;
export const PublicIncidentsIndexSchema = strict.incidentsIndex;
export const PublicArchiveSchema = strict.archive;
export const PublicUptimeSchema = strict.uptime;
export const PublicBreakglassSchema = strict.breakglass;
export const PublicExternalSchema = strict.external;
export const PublicStatusJsonSchema = strict.statusJson;
export const PublicIncidentHeadSchema = strict.incidentHead;
export const PublicComponentSchema = strict.component;
export const PublicUpdateSchema = strict.update;

export const LenientPublicSummarySchema = lenient.summary;
export const LenientPublicIncidentDetailSchema = lenient.incidentDetail;
export const LenientPublicIncidentsIndexSchema = lenient.incidentsIndex;
export const LenientPublicArchiveSchema = lenient.archive;
export const LenientPublicUptimeSchema = lenient.uptime;
export const LenientPublicBreakglassSchema = lenient.breakglass;
export const LenientPublicExternalSchema = lenient.external;
export const LenientPublicStatusJsonSchema = lenient.statusJson;
export const LenientPublicIncidentHeadSchema = lenient.incidentHead;

export type PublicSummary = z.output<typeof PublicSummarySchema>;
export type PublicIncidentHead = z.output<typeof PublicIncidentHeadSchema>;
export type PublicIncidentIndexRow = z.output<typeof PublicIncidentsIndexSchema>['incidents'][number];
export type PublicComponent = z.output<typeof PublicComponentSchema>;
export type PublicUpdate = z.output<typeof PublicUpdateSchema>;
export type PublicIncidentDetail = z.output<typeof PublicIncidentDetailSchema>;
export type PublicIncidentsIndex = z.output<typeof PublicIncidentsIndexSchema>;
export type PublicArchive = z.output<typeof PublicArchiveSchema>;
export type PublicUptime = z.output<typeof PublicUptimeSchema>;
export type PublicBreakglass = z.output<typeof PublicBreakglassSchema>;
export type PublicBreakglassEntry = PublicBreakglass['entries'][number];
export type PublicExternal = z.output<typeof PublicExternalSchema>;
export type PublicStatusJson = z.output<typeof PublicStatusJsonSchema>;

export const PUBLIC_FILE_KINDS = [
  'summary',
  'incident',
  'incidents',
  'archive',
  'uptime',
  'breakglass',
  'external',
  'statusJson',
] as const;
export type PublicFileKind = (typeof PUBLIC_FILE_KINDS)[number];

export const STRICT_PUBLIC_SCHEMAS = {
  summary: PublicSummarySchema,
  incident: PublicIncidentDetailSchema,
  incidents: PublicIncidentsIndexSchema,
  archive: PublicArchiveSchema,
  uptime: PublicUptimeSchema,
  breakglass: PublicBreakglassSchema,
  external: PublicExternalSchema,
  statusJson: PublicStatusJsonSchema,
} as const;

export const LENIENT_PUBLIC_SCHEMAS = {
  summary: LenientPublicSummarySchema,
  incident: LenientPublicIncidentDetailSchema,
  incidents: LenientPublicIncidentsIndexSchema,
  archive: LenientPublicArchiveSchema,
  uptime: LenientPublicUptimeSchema,
  breakglass: LenientPublicBreakglassSchema,
  external: LenientPublicExternalSchema,
  statusJson: LenientPublicStatusJsonSchema,
} as const;

type FileOutput = {
  summary: PublicSummary;
  incident: PublicIncidentDetail;
  incidents: PublicIncidentsIndex;
  archive: PublicArchive;
  uptime: PublicUptime;
  breakglass: PublicBreakglass;
  external: PublicExternal;
  statusJson: PublicStatusJson;
};

export type ParsedPublicFile<K extends PublicFileKind> =
  { ok: true; data: FileOutput[K] } | { ok: false; error: z.ZodError };

/** Strict: publishers and tests. Lenient: clients, which strip keys a newer publisher added. */
export function parsePublicFile<K extends PublicFileKind>(
  kind: K,
  input: unknown,
  mode: PublicSchemaMode
): ParsedPublicFile<K> {
  const schema = (mode === 'strict' ? STRICT_PUBLIC_SCHEMAS : LENIENT_PUBLIC_SCHEMAS)[kind] as unknown as z.ZodType<
    FileOutput[K]
  >;
  const result = schema.safeParse(input);
  return result.success ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

export const parseSummaryStrict = (input: unknown) => parsePublicFile('summary', input, 'strict');
export const parseSummaryLenient = (input: unknown) => parsePublicFile('summary', input, 'lenient');
