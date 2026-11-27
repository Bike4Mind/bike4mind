import type { z } from 'zod';
import { STRICT_PUBLIC_SCHEMAS, type PublicFileKind } from './schemas.public';

interface ZodDefLike {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  items?: z.ZodType[];
  options?: z.ZodType[];
}

function defOf(schema: z.ZodType): ZodDefLike {
  return (schema as unknown as { _zod: { def: ZodDefLike } })._zod.def;
}

function walk(schema: z.ZodType, prefix: string, out: Set<string>): void {
  const def = defOf(schema);
  switch (def.type) {
    case 'object':
      for (const [key, child] of Object.entries(def.shape ?? {})) {
        const path = prefix ? `${prefix}.${key}` : key;
        out.add(path);
        walk(child, path, out);
      }
      break;
    case 'array':
      if (def.element) walk(def.element, `${prefix}[]`, out);
      break;
    case 'tuple':
      (def.items ?? []).forEach((item, index) => {
        out.add(`${prefix}[${index}]`);
        walk(item, `${prefix}[${index}]`, out);
      });
      break;
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
      if (def.innerType) walk(def.innerType, prefix, out);
      break;
    case 'union':
      (def.options ?? []).forEach(option => walk(option, prefix, out));
      break;
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'enum':
    case 'literal':
    case 'date':
    case 'null':
      break;
    default:
      throw new Error(`collectSchemaKeyPaths: cannot walk a ${def.type} schema at ${prefix || '<root>'}`);
  }
}

/** Every key path of a zod schema: `a.b` for object keys, `a[]` for array items, `a[0]` for tuple slots. */
export function collectSchemaKeyPaths(schema: z.ZodType, prefix = ''): string[] {
  const out = new Set<string>();
  walk(schema, prefix, out);
  return [...out].sort();
}

/** Key paths of every strict public schema, prefixed by file kind. */
export function collectPublicSnapshotKeyPaths(): string[] {
  const all: string[] = [];
  for (const kind of Object.keys(STRICT_PUBLIC_SCHEMAS) as PublicFileKind[]) {
    all.push(...collectSchemaKeyPaths(STRICT_PUBLIC_SCHEMAS[kind], kind));
  }
  return all.sort();
}

/**
 * Checked in on purpose: adding a public field means editing this list in the same change, so a
 * new field cannot reach a public file without a reviewer seeing it here.
 */
export const PUBLIC_SNAPSHOT_KEY_PATHS: readonly string[] = [
  'archive.incidents',
  'archive.incidents[].completedEarlyAt',
  'archive.incidents[].components',
  'archive.incidents[].components[].impact',
  'archive.incidents[].components[].slug',
  'archive.incidents[].id',
  'archive.incidents[].impact',
  'archive.incidents[].kind',
  'archive.incidents[].resolvedAt',
  'archive.incidents[].scheduledEndAt',
  'archive.incidents[].scheduledStartAt',
  'archive.incidents[].startedAt',
  'archive.incidents[].status',
  'archive.incidents[].title',
  'archive.incidents[].updateCount',
  'archive.incidents[].updatedAt',
  'archive.schemaVersion',
  'archive.year',
  'breakglass.entries',
  'breakglass.entries[].completedEarlyAt',
  'breakglass.entries[].components',
  'breakglass.entries[].components[].impact',
  'breakglass.entries[].components[].slug',
  'breakglass.entries[].id',
  'breakglass.entries[].impact',
  'breakglass.entries[].journalNonce',
  'breakglass.entries[].kind',
  'breakglass.entries[].latestUpdates',
  'breakglass.entries[].latestUpdates[].at',
  'breakglass.entries[].latestUpdates[].body',
  'breakglass.entries[].latestUpdates[].edited',
  'breakglass.entries[].latestUpdates[].editedAt',
  'breakglass.entries[].latestUpdates[].id',
  'breakglass.entries[].latestUpdates[].status',
  'breakglass.entries[].latestUpdates[].truncated',
  'breakglass.entries[].resolvedAt',
  'breakglass.entries[].scheduledEndAt',
  'breakglass.entries[].scheduledStartAt',
  'breakglass.entries[].startedAt',
  'breakglass.entries[].status',
  'breakglass.entries[].title',
  'breakglass.entries[].updateCount',
  'breakglass.entries[].updatedAt',
  'breakglass.entries[].writtenSeq',
  'breakglass.externalOverride',
  'breakglass.externalOverride.ignoreUntil',
  'breakglass.externalOverride.writtenSeq',
  'breakglass.schemaVersion',
  'breakglass.seq',
  'breakglass.updatedAt',
  'external.checkedAt',
  'external.schemaVersion',
  'external.seq',
  'external.since',
  'external.state',
  'incident.generatedAt',
  'incident.incident',
  'incident.incident.completedEarlyAt',
  'incident.incident.components',
  'incident.incident.components[].impact',
  'incident.incident.components[].slug',
  'incident.incident.id',
  'incident.incident.impact',
  'incident.incident.kind',
  'incident.incident.resolvedAt',
  'incident.incident.scheduledEndAt',
  'incident.incident.scheduledStartAt',
  'incident.incident.startedAt',
  'incident.incident.status',
  'incident.incident.title',
  'incident.incident.updateCount',
  'incident.incident.updatedAt',
  'incident.incident.updates',
  'incident.incident.updates[].at',
  'incident.incident.updates[].body',
  'incident.incident.updates[].edited',
  'incident.incident.updates[].id',
  'incident.incident.updates[].status',
  'incident.incident.updates[].truncated',
  'incident.postmortem',
  'incident.postmortem.body',
  'incident.postmortem.publishedAt',
  'incident.postmortem.url',
  'incident.schemaVersion',
  'incidents.generatedAt',
  'incidents.incidents',
  'incidents.incidents[].completedEarlyAt',
  'incidents.incidents[].components',
  'incidents.incidents[].components[].impact',
  'incidents.incidents[].components[].slug',
  'incidents.incidents[].id',
  'incidents.incidents[].impact',
  'incidents.incidents[].kind',
  'incidents.incidents[].resolvedAt',
  'incidents.incidents[].scheduledEndAt',
  'incidents.incidents[].scheduledStartAt',
  'incidents.incidents[].startedAt',
  'incidents.incidents[].status',
  'incidents.incidents[].title',
  'incidents.incidents[].updateCount',
  'incidents.incidents[].updatedAt',
  'incidents.schemaVersion',
  'incidents.seq',
  'incidents.windowDays',
  'statusJson.page',
  'statusJson.page.name',
  'statusJson.page.updated_at',
  'statusJson.page.url',
  'statusJson.status',
  'statusJson.status.description',
  'statusJson.status.indicator',
  'summary.activeIncidents',
  'summary.activeIncidents[].completedEarlyAt',
  'summary.activeIncidents[].components',
  'summary.activeIncidents[].components[].impact',
  'summary.activeIncidents[].components[].slug',
  'summary.activeIncidents[].id',
  'summary.activeIncidents[].impact',
  'summary.activeIncidents[].kind',
  'summary.activeIncidents[].latestUpdates',
  'summary.activeIncidents[].latestUpdates[].at',
  'summary.activeIncidents[].latestUpdates[].body',
  'summary.activeIncidents[].latestUpdates[].edited',
  'summary.activeIncidents[].latestUpdates[].id',
  'summary.activeIncidents[].latestUpdates[].status',
  'summary.activeIncidents[].latestUpdates[].truncated',
  'summary.activeIncidents[].resolvedAt',
  'summary.activeIncidents[].scheduledEndAt',
  'summary.activeIncidents[].scheduledStartAt',
  'summary.activeIncidents[].startedAt',
  'summary.activeIncidents[].status',
  'summary.activeIncidents[].title',
  'summary.activeIncidents[].updateCount',
  'summary.activeIncidents[].updatedAt',
  'summary.breakglassAppliedSeq',
  'summary.components',
  'summary.components[].autoDetected',
  'summary.components[].baseState',
  'summary.components[].children',
  'summary.components[].children[].autoDetected',
  'summary.components[].children[].baseState',
  'summary.components[].children[].description',
  'summary.components[].children[].externallyMonitored',
  'summary.components[].children[].maintenance',
  'summary.components[].children[].maintenance.endsAt',
  'summary.components[].children[].maintenance.incidentId',
  'summary.components[].children[].monitoring',
  'summary.components[].children[].name',
  'summary.components[].children[].order',
  'summary.components[].children[].slug',
  'summary.components[].children[].state',
  'summary.components[].children[].vendor',
  'summary.components[].children[].vendor.statusPageUrl',
  'summary.components[].children[].vendor.upstream',
  'summary.components[].children[].vendor.upstream.checkedAt',
  'summary.components[].children[].vendor.upstream.indicator',
  'summary.components[].description',
  'summary.components[].externallyMonitored',
  'summary.components[].group',
  'summary.components[].maintenance',
  'summary.components[].maintenance.endsAt',
  'summary.components[].maintenance.incidentId',
  'summary.components[].monitoring',
  'summary.components[].name',
  'summary.components[].order',
  'summary.components[].slug',
  'summary.components[].state',
  'summary.components[].vendor',
  'summary.components[].vendor.statusPageUrl',
  'summary.components[].vendor.upstream',
  'summary.components[].vendor.upstream.checkedAt',
  'summary.components[].vendor.upstream.indicator',
  'summary.externalIgnoredUntil',
  'summary.generatedAt',
  'summary.groups',
  'summary.groups[].name',
  'summary.groups[].order',
  'summary.groups[].slug',
  'summary.hardStaleAfterSeconds',
  'summary.moreActiveIncidents',
  'summary.overall',
  'summary.overall.notice',
  'summary.overall.state',
  'summary.page',
  'summary.page.appUrl',
  'summary.page.linkHosts',
  'summary.page.supportEmail',
  'summary.page.title',
  'summary.probesAsOf',
  'summary.probesTrigger',
  'summary.schemaVersion',
  'summary.seq',
  'summary.staleAfterSeconds',
  'summary.upcomingMaintenance',
  'summary.upcomingMaintenance[].completedEarlyAt',
  'summary.upcomingMaintenance[].components',
  'summary.upcomingMaintenance[].components[].impact',
  'summary.upcomingMaintenance[].components[].slug',
  'summary.upcomingMaintenance[].id',
  'summary.upcomingMaintenance[].impact',
  'summary.upcomingMaintenance[].kind',
  'summary.upcomingMaintenance[].latestUpdates',
  'summary.upcomingMaintenance[].latestUpdates[].at',
  'summary.upcomingMaintenance[].latestUpdates[].body',
  'summary.upcomingMaintenance[].latestUpdates[].edited',
  'summary.upcomingMaintenance[].latestUpdates[].id',
  'summary.upcomingMaintenance[].latestUpdates[].status',
  'summary.upcomingMaintenance[].latestUpdates[].truncated',
  'summary.upcomingMaintenance[].resolvedAt',
  'summary.upcomingMaintenance[].scheduledEndAt',
  'summary.upcomingMaintenance[].scheduledStartAt',
  'summary.upcomingMaintenance[].startedAt',
  'summary.upcomingMaintenance[].status',
  'summary.upcomingMaintenance[].title',
  'summary.upcomingMaintenance[].updateCount',
  'summary.upcomingMaintenance[].updatedAt',
  'uptime.components',
  'uptime.components[].days',
  'uptime.components[].days[][0]',
  'uptime.components[].days[][1]',
  'uptime.components[].days[][2]',
  'uptime.components[].days[][3]',
  'uptime.components[].slug',
  'uptime.components[].uptime',
  'uptime.from',
  'uptime.generatedAt',
  'uptime.schemaVersion',
  'uptime.to',
];
