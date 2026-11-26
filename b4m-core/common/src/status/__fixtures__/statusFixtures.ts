import type { z } from 'zod';
import type { ProjectionInput } from '../project';
import type { PublicBreakglass, PublicExternal, PublicIncidentHead, PublicSummary } from '../schemas.public';
import type { StatusComponentDoc, StatusComponentRuntime, StatusIncidentDoc } from '../types';

export const NOW = new Date('2026-11-23T19:40:07Z');
export const SENTINEL_PREFIX = 'SENTINEL_';
export const SENTINEL_DATE = new Date('2031-03-03T03:03:03Z');
export const SENTINEL_NUMBER = 7777771;

export function minutesAgo(minutes: number, from: Date = NOW): Date {
  return new Date(from.getTime() - minutes * 60_000);
}

export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface DefLike {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: unknown[];
  entries?: Record<string, unknown>;
  values?: unknown[];
}

const defOf = (schema: z.ZodType) => (schema as unknown as { _zod: { def: DefLike } })._zod.def;

/** Fills every field of an admin schema with a sentinel value so a leak is findable as bytes. */
export function fillFromSchema(schema: z.ZodType, path = ''): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(def.shape ?? {}).map(([key, child]) => [
          key,
          fillFromSchema(child, path ? `${path}.${key}` : key),
        ])
      );
    case 'array':
      return [fillFromSchema(def.element as z.ZodType, `${path}[]`)];
    case 'optional':
    case 'nullable':
      return fillFromSchema(def.innerType as z.ZodType, path);
    case 'string':
      return `${SENTINEL_PREFIX}${path}`;
    case 'number':
      return SENTINEL_NUMBER;
    case 'boolean':
      return true;
    case 'date':
      return new Date(SENTINEL_DATE);
    case 'enum':
      return Object.values(def.entries ?? {})[0];
    default:
      throw new Error(`fillFromSchema: unsupported ${def.type} at ${path}`);
  }
}

export function collectSentinelStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.includes(SENTINEL_PREFIX)) out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach(item => collectSentinelStrings(item, out));
  } else if (value && typeof value === 'object' && !(value instanceof Date)) {
    Object.values(value).forEach(item => collectSentinelStrings(item, out));
  }
  return out;
}

export function makeComponent(overrides: Partial<StatusComponentDoc> = {}): StatusComponentDoc {
  return {
    key: 'chat',
    publicSlug: 'chat',
    source: 'core',
    name: 'Chat and AI responses',
    group: 'platform',
    order: 2,
    visibility: 'public',
    monitoring: 'probed',
    externallyMonitored: false,
    probeKeys: ['chat.completions'],
    createdAt: minutesAgo(100_000),
    updatedAt: minutesAgo(100_000),
    ...overrides,
  };
}

export function makeRuntime(
  overrides: Partial<Omit<StatusComponentRuntime, 'component'>> & { component?: Partial<StatusComponentDoc> } = {}
): StatusComponentRuntime {
  const { component, ...rest } = overrides;
  return { component: makeComponent(component), automaticState: 'operational', ...rest };
}

export function makeIncident(overrides: Partial<StatusIncidentDoc> = {}): StatusIncidentDoc {
  return {
    publicId: 'k3v9q2m7xa',
    kind: 'incident',
    published: true,
    source: 'admin',
    classification: 'standard',
    title: 'Chat responses are slow',
    status: 'investigating',
    impact: 'major',
    components: [{ componentKey: 'chat', impact: 'partial_outage' }],
    startedAt: minutesAgo(30),
    updates: [
      {
        updateId: 'u_one',
        at: minutesAgo(25),
        status: 'investigating',
        body: 'We are investigating slow chat responses. Next update in 30 minutes.',
        authorId: 'author-1',
        editHistory: [],
      },
    ],
    internalNotes: [],
    version: 1,
    createdBy: 'author-1',
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(25),
    ...overrides,
  };
}

export function makeProjectionInput(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    now: NOW,
    seq: 48211,
    probesAsOf: minutesAgo(1),
    probesTrigger: 'scheduled',
    breakglassAppliedSeq: 0,
    externalIgnoredUntil: null,
    page: {
      title: 'Example Status',
      appUrl: 'https://app.example.com',
      linkHosts: ['app.example.com', 'docs.example.com'],
    },
    groups: [{ slug: 'platform', name: 'Platform', order: 0 }],
    components: [makeRuntime()],
    incidents: [],
    ...overrides,
  };
}

export function makeHead(overrides: Partial<PublicIncidentHead> = {}): PublicIncidentHead {
  return {
    id: 'k3v9q2m7xa',
    kind: 'incident',
    title: 'Chat responses are slow',
    status: 'identified',
    impact: 'major',
    components: [{ slug: 'chat', impact: 'partial_outage' }],
    startedAt: isoSeconds(minutesAgo(30)),
    resolvedAt: null,
    scheduledStartAt: null,
    scheduledEndAt: null,
    completedEarlyAt: null,
    updatedAt: isoSeconds(minutesAgo(10)),
    updateCount: 1,
    latestUpdates: [
      {
        id: 'u_one',
        at: isoSeconds(minutesAgo(10)),
        status: 'identified',
        body: 'Working on it.',
        edited: false,
        truncated: false,
      },
    ],
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<PublicSummary> = {}): PublicSummary {
  return {
    schemaVersion: 1,
    seq: 48211,
    generatedAt: isoSeconds(minutesAgo(1)),
    probesAsOf: isoSeconds(minutesAgo(1)),
    probesTrigger: 'scheduled',
    staleAfterSeconds: 240,
    hardStaleAfterSeconds: 900,
    breakglassAppliedSeq: 12,
    externalIgnoredUntil: null,
    page: {
      title: 'Example Status',
      appUrl: 'https://app.example.com',
      linkHosts: ['app.example.com'],
      supportEmail: null,
    },
    overall: { state: 'operational', notice: null },
    groups: [{ slug: 'platform', name: 'Platform', order: 0 }],
    components: [
      {
        slug: 'chat',
        name: 'Chat and AI responses',
        group: 'platform',
        order: 2,
        description: null,
        state: 'operational',
        baseState: 'operational',
        monitoring: 'probed',
        autoDetected: false,
        externallyMonitored: true,
        maintenance: null,
        children: [],
        vendor: null,
      },
    ],
    activeIncidents: [],
    upcomingMaintenance: [],
    moreActiveIncidents: 0,
    ...overrides,
  };
}

export function makeExternal(overrides: Partial<PublicExternal> = {}): PublicExternal {
  return {
    schemaVersion: 1,
    seq: 90412,
    state: 'up',
    since: isoSeconds(minutesAgo(60)),
    checkedAt: isoSeconds(minutesAgo(0.5)),
    ...overrides,
  };
}

export function makeBreakglass(
  entries: PublicBreakglass['entries'] = [],
  overrides: Partial<PublicBreakglass> = {}
): PublicBreakglass {
  return {
    schemaVersion: 1,
    seq: 13,
    updatedAt: isoSeconds(minutesAgo(1)),
    entries,
    externalOverride: null,
    ...overrides,
  };
}

/** A projection input that touches every public shape: vendor row, child row, maintenance, postmortem, uptime. */
export function makeRichInput(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  const parent = makeRuntime({ component: { key: 'sign-in', publicSlug: 'sign-in', name: 'Sign in', order: 4 } });
  const child = makeRuntime({
    component: {
      key: 'sign-in-google',
      publicSlug: 'sign-in-google',
      name: 'Sign in with Google',
      order: 5,
      parentKey: 'sign-in',
    },
    automaticState: 'degraded',
  });
  const vendor = makeRuntime({
    component: {
      key: 'provider-example',
      publicSlug: 'example-provider',
      name: 'Example Provider',
      group: 'providers',
      order: 1,
      monitoring: 'vendor',
      vendor: {
        key: 'example-provider',
        displayName: 'Example Provider',
        statusPageUrl: 'https://status.example.org',
        publicNaming: true,
      },
    },
    vendorFeed: { indicator: 'minor', checkedAt: minutesAgo(2) },
  });
  return makeProjectionInput({
    groups: [
      { slug: 'platform', name: 'Platform', order: 0 },
      { slug: 'providers', name: 'AI model providers', order: 1 },
    ],
    components: [makeRuntime(), parent, child, vendor],
    incidents: [
      makeIncident(),
      makeIncident({
        publicId: 'm4intenanc',
        kind: 'maintenance',
        title: 'Planned maintenance',
        status: 'scheduled',
        impact: 'none',
        components: [{ componentKey: 'sign-in', impact: 'degraded' }],
        startedAt: minutesAgo(600),
        scheduledStartAt: new Date(NOW.getTime() + 3 * 3_600_000),
        scheduledEndAt: new Date(NOW.getTime() + 4 * 3_600_000),
        announcedAt: minutesAgo(500),
        updates: [
          {
            updateId: 'u_m1',
            at: minutesAgo(500),
            status: 'scheduled',
            body: 'Maintenance is planned.',
            authorId: 'author-1',
            editHistory: [],
          },
        ],
      }),
      makeIncident({
        publicId: 'mnt0inprog',
        kind: 'maintenance',
        title: 'Maintenance in progress',
        status: 'scheduled',
        impact: 'none',
        components: [{ componentKey: 'sign-in', impact: 'degraded' }],
        startedAt: minutesAgo(900),
        scheduledStartAt: minutesAgo(10),
        scheduledEndAt: new Date(NOW.getTime() + 3_600_000),
        announcedAt: minutesAgo(800),
        updates: [
          {
            updateId: 'u_m0',
            at: minutesAgo(800),
            status: 'scheduled',
            body: 'Maintenance has started.',
            authorId: 'author-1',
            editHistory: [],
          },
        ],
      }),
      makeIncident({
        publicId: 'r3solved01',
        title: 'Earlier outage',
        status: 'resolved',
        impact: 'critical',
        startedAt: minutesAgo(5_000),
        resolvedAt: minutesAgo(4_900),
        updatedAt: minutesAgo(4_900),
        components: [{ componentKey: 'chat', impact: 'major_outage' }],
        updates: [
          {
            updateId: 'u_r1',
            at: minutesAgo(4_990),
            status: 'investigating',
            body: 'Looking into it.',
            authorId: 'author-1',
            editHistory: [],
          },
          {
            updateId: 'u_r2',
            at: minutesAgo(4_900),
            status: 'resolved',
            body: 'Resolved.',
            authorId: 'author-2',
            editedAt: minutesAgo(4_890),
            editHistory: [],
          },
        ],
        postmortem: {
          url: 'https://docs.example.com/postmortem',
          body: 'What **happened**.',
          publishedAt: minutesAgo(4_000),
        },
      }),
    ],
    uptime: [
      {
        componentKey: 'chat',
        uptime: 0.99953,
        days: [
          { day: '2026-11-22', barCode: 'o', uptimeBp: 10_000, downtimeMinutes: 0, incidentIds: [] },
          { day: '2026-11-23', barCode: 'p', uptimeBp: 9_995, downtimeMinutes: 12.4, incidentIds: ['k3v9q2m7xa'] },
        ],
      },
    ],
    ...overrides,
  });
}
