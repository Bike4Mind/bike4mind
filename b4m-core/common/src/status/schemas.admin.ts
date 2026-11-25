import { z } from 'zod';
import { ALL_INCIDENT_STATUSES, INCIDENT_KINDS } from './isActive';
import { COMPONENT_IMPACTS, OVERALL_IMPACTS } from './stateOrder';
import {
  COMPONENT_MONITORING,
  COMPONENT_SOURCES,
  COMPONENT_VISIBILITIES,
  INCIDENT_CLASSIFICATIONS,
  INCIDENT_SOURCES,
  type StatusComponentDoc,
  type StatusIncidentDoc,
  type StatusIncidentUpdateDoc,
} from './types';

// Dot-paths of every key, so the check below sees nested objects and array elements.
type KeyPaths<T> = T extends Date | string | number | boolean | bigint | null | undefined
  ? never
  : T extends readonly (infer U)[]
    ? '[]' | `[].${KeyPaths<U>}`
    : { [K in keyof T & string]-?: K | `${K}.${KeyPaths<NonNullable<T[K]>>}` }[keyof T & string];

// Compile-time check that the schema and the document type name the same keys at every depth, without
// losing `.shape`: a key added to one and not the other fails typecheck. Optionality and value types
// are not compared; `z.ZodType<T>` covers only the schema output being assignable to the document.
const describes =
  <T>() =>
  <S extends z.ZodType<T>>(
    schema: S &
      ([Exclude<KeyPaths<T>, KeyPaths<z.output<S>>>] extends [never]
        ? [Exclude<KeyPaths<z.output<S>>, KeyPaths<T>>] extends [never]
          ? unknown
          : never
        : never)
  ): S =>
    schema;

const date = z.date();
const impact = z.enum(COMPONENT_IMPACTS);
const overall = z.enum(OVERALL_IMPACTS);

/** Admin-tier shape of statusComponents documents. Never serialized into a public file. */
export const StatusComponentAdminSchema = describes<StatusComponentDoc>()(
  z.object({
    key: z.string(),
    publicSlug: z.string(),
    source: z.enum(COMPONENT_SOURCES),
    contributorId: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    group: z.string(),
    order: z.number(),
    visibility: z.enum(COMPONENT_VISIBILITIES),
    monitoring: z.enum(COMPONENT_MONITORING),
    vendor: z
      .object({ key: z.string(), displayName: z.string(), statusPageUrl: z.string(), publicNaming: z.boolean() })
      .optional(),
    externallyMonitored: z.boolean(),
    probeKeys: z.array(z.string()),
    hysteresis: z.object({ fail: z.number(), recover: z.number() }).optional(),
    retiredAt: date.optional(),
    parentKey: z.string().optional(),
    createdAt: date,
    updatedAt: date,
  })
);

export const StatusIncidentUpdateAdminSchema = describes<StatusIncidentUpdateDoc>()(
  z.object({
    updateId: z.string(),
    at: date,
    status: z.enum(ALL_INCIDENT_STATUSES),
    body: z.string(),
    authorId: z.string(),
    impactChange: z.object({ from: overall, to: overall }).optional(),
    componentChanges: z
      .array(z.object({ componentKey: z.string(), from: impact.nullable(), to: impact.nullable() }))
      .optional(),
    editedAt: date.optional(),
    editHistory: z.array(z.object({ at: date, editorId: z.string(), body: z.string() })),
  })
);

/** Admin-tier shape of statusIncidents documents. Only the allowlisted copy in project.ts is public. */
export const StatusIncidentAdminSchema = describes<StatusIncidentDoc>()(
  z.object({
    publicId: z.string(),
    kind: z.enum(INCIDENT_KINDS),
    published: z.boolean(),
    firstPublishedAt: date.optional(),
    detectedAt: date.optional(),
    source: z.enum(INCIDENT_SOURCES),
    classification: z.enum(INCIDENT_CLASSIFICATIONS),
    title: z.string(),
    status: z.enum(ALL_INCIDENT_STATUSES),
    impact: overall,
    components: z.array(z.object({ componentKey: z.string(), impact })),
    startedAt: date,
    resolvedAt: date.optional(),
    scheduledStartAt: date.optional(),
    scheduledEndAt: date.optional(),
    completedEarlyAt: date.optional(),
    cancelledAt: date.optional(),
    announcedAt: date.optional(),
    plannedMessages: z.object({ start: z.string().optional(), end: z.string().optional() }).optional(),
    updates: z.array(StatusIncidentUpdateAdminSchema),
    internalNotes: z.array(z.object({ at: date, authorId: z.string(), body: z.string() })),
    postmortem: z
      .object({ url: z.string().optional(), body: z.string().optional(), publishedAt: date.optional() })
      .optional(),
    postmortemDueAt: date.optional(),
    detection: z
      .object({ firstFailureAt: date, probeKeys: z.array(z.string()), upstream: z.string().optional() })
      .optional(),
    breakGlass: z
      .object({
        journalKeys: z.array(z.string()),
        actorIds: z.array(z.string()),
        firstWrittenAt: date,
        backdateConfirmedBy: z.string().optional(),
      })
      .optional(),
    retracted: z.object({ at: date, by: z.string(), reason: z.string() }).optional(),
    version: z.number(),
    createdBy: z.string(),
    createdAt: date,
    updatedAt: date,
  })
);
