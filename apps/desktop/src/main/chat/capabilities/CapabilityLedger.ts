import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type {
  Capability,
  CapabilityAuditEvent,
  CapabilityGrant,
  CapabilityLedgerState,
  CapabilityScope,
  CapabilitySubject,
} from '@shared/capabilities';
import type { PermissionRuleLists } from '@shared/permissions';

const subjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('desktop-user') }),
  z.object({ kind: z.literal('project'), directory: z.string() }),
  z.object({ kind: z.literal('session'), sessionId: z.string() }),
]);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), value: z.string() }),
  z.object({ kind: z.literal('permission-rule'), value: z.string() }),
  z.object({
    kind: z.literal('browser-origin'),
    value: z.string(),
    access: z.enum(['network', 'read', 'act', 'script']),
  }),
  z.object({ kind: z.literal('tool'), value: z.string() }),
  z.object({ kind: z.literal('project'), value: z.string() }),
  z.object({ kind: z.literal('approval'), value: z.string() }),
]);
const capabilitySchema = z.enum(['files', 'tool', 'browser-origin', 'credits', 'imported-identity', 'project-trust']);
const grantSchema = z.object({
  id: z.string(),
  subject: subjectSchema,
  capability: capabilitySchema,
  scope: scopeSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  source: z.enum(['folder-picker', 'permission-rule', 'project-trust', 'approval', 'migration']),
});
const eventSchema = z.discriminatedUnion('type', [
  z.object({
    sequence: z.number().int().nonnegative(),
    type: z.literal('grant'),
    timestamp: z.string().datetime(),
    grant: grantSchema,
    migrationKey: z.string().optional(),
  }),
  z.object({
    sequence: z.number().int().nonnegative(),
    type: z.literal('use'),
    timestamp: z.string().datetime(),
    grantId: z.string().optional(),
    capability: capabilitySchema,
    scope: scopeSchema,
  }),
  z.object({
    sequence: z.number().int().nonnegative(),
    type: z.enum(['revoke', 'expire']),
    timestamp: z.string().datetime(),
    grantId: z.string(),
  }),
]);
const fileSchema = z.object({ version: z.literal(1), events: z.array(eventSchema) }).superRefine((value, context) => {
  value.events.forEach((event, index) => {
    if (event.sequence !== index)
      context.addIssue({ code: 'custom', path: ['events', index, 'sequence'], message: 'Out of order' });
  });
});

type AppendEvent =
  | Omit<Extract<CapabilityAuditEvent, { type: 'grant' }>, 'sequence'>
  | Omit<Extract<CapabilityAuditEvent, { type: 'use' }>, 'sequence'>
  | Omit<Extract<CapabilityAuditEvent, { type: 'revoke' | 'expire' }>, 'sequence'>;

interface MigrationInput {
  roots: readonly string[];
  trustedProjects: readonly string[];
  permissions: { user: PermissionRuleLists; projects: Record<string, PermissionRuleLists> };
}

export class CapabilityLedger {
  private events: CapabilityAuditEvent[] | null = null;
  private loading: Promise<CapabilityAuditEvent[]> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async state(): Promise<CapabilityLedgerState> {
    await this.expireDue();
    const events = await this.read();
    const grants = new Map<string, CapabilityGrant>();
    for (const event of events) {
      if (event.type === 'grant') grants.set(event.grant.id, { ...event.grant });
      else if (event.type === 'revoke') {
        const grant = grants.get(event.grantId);
        if (grant) grant.revokedAt = event.timestamp;
      } else if (event.type === 'expire') {
        const grant = grants.get(event.grantId);
        if (grant) grant.expiredAt = event.timestamp;
      }
    }
    return {
      grants: [...grants.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      audit: [...events].reverse(),
    };
  }

  async grant(input: {
    subject: CapabilitySubject;
    capability: Capability;
    scope: CapabilityScope;
    expiresAt?: string;
    source: CapabilityGrant['source'];
    migrationKey?: string;
  }): Promise<CapabilityGrant> {
    const timestamp = this.now().toISOString();
    const grant: CapabilityGrant = {
      id: randomUUID(),
      subject: input.subject,
      capability: input.capability,
      scope: normalizeScope(input.scope),
      createdAt: timestamp,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      source: input.source,
    };
    await this.append({
      type: 'grant',
      timestamp,
      grant,
      ...(input.migrationKey ? { migrationKey: input.migrationKey } : {}),
    });
    return grant;
  }

  async use(capability: Capability, scope: CapabilityScope, grantId?: string): Promise<void> {
    await this.append({
      type: 'use',
      timestamp: this.now().toISOString(),
      capability,
      scope: normalizeScope(scope),
      ...(grantId ? { grantId } : {}),
    });
  }

  async revoke(
    grantId: string,
    enforce?: (grant: CapabilityGrant) => Promise<void> | void
  ): Promise<CapabilityGrant | null> {
    const grant = (await this.state()).grants.find(
      entry => entry.id === grantId && !entry.revokedAt && !entry.expiredAt
    );
    if (!grant) return null;
    await enforce?.(grant);
    await this.append({ type: 'revoke', timestamp: this.now().toISOString(), grantId });
    return grant;
  }

  async revokeMatching(match: (grant: CapabilityGrant) => boolean): Promise<CapabilityGrant[]> {
    const active = (await this.state()).grants.filter(grant => !grant.revokedAt && !grant.expiredAt && match(grant));
    for (const grant of active)
      await this.append({ type: 'revoke', timestamp: this.now().toISOString(), grantId: grant.id });
    return active;
  }

  async migrate(input: MigrationInput): Promise<void> {
    const existing = new Set(
      (await this.read()).flatMap(event => (event.type === 'grant' && event.migrationKey ? [event.migrationKey] : []))
    );
    const additions: Array<Parameters<CapabilityLedger['grant']>[0]> = [];
    for (const root of input.roots) {
      const value = resolve(root);
      additions.push({
        subject: { kind: 'desktop-user' },
        capability: 'files',
        scope: { kind: 'path', value },
        source: 'migration',
        migrationKey: `path:${value}`,
      });
    }
    for (const directory of input.trustedProjects) {
      const value = resolve(directory);
      additions.push({
        subject: { kind: 'project', directory: value },
        capability: 'project-trust',
        scope: { kind: 'project', value },
        source: 'migration',
        migrationKey: `trust:${value}`,
      });
    }
    for (const [directory, lists] of [
      ['', input.permissions.user] as const,
      ...Object.entries(input.permissions.projects),
    ]) {
      for (const rule of lists.allow) {
        additions.push({
          subject: directory ? { kind: 'project', directory: resolve(directory) } : { kind: 'desktop-user' },
          capability: 'tool',
          scope: { kind: 'permission-rule', value: rule },
          source: 'migration',
          migrationKey: `rule:${directory}:${rule}`,
        });
      }
    }
    for (const addition of additions) if (!existing.has(addition.migrationKey!)) await this.grant(addition);
  }

  private async expireDue(): Promise<void> {
    const events = await this.read();
    const ended = new Set(
      events.flatMap(event => (event.type === 'revoke' || event.type === 'expire' ? [event.grantId] : []))
    );
    const now = this.now();
    for (const event of events) {
      if (
        event.type === 'grant' &&
        event.grant.expiresAt &&
        !ended.has(event.grant.id) &&
        new Date(event.grant.expiresAt) <= now
      ) {
        await this.append({ type: 'expire', timestamp: now.toISOString(), grantId: event.grant.id });
        ended.add(event.grant.id);
      }
    }
  }

  private async read(): Promise<CapabilityAuditEvent[]> {
    if (this.events) return this.events;
    this.loading ??= this.load();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async load(): Promise<CapabilityAuditEvent[]> {
    try {
      const parsed = fileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
      this.events = parsed.events as CapabilityAuditEvent[];
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      this.events = [];
    }
    return this.events;
  }

  private append(event: AppendEvent): Promise<void> {
    const run = this.writing.then(async () => {
      const current = await this.read();
      const next = [...current, { ...event, sequence: current.length } as CapabilityAuditEvent];
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, events: next }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
      this.events = next;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }
}

function normalizeScope(scope: CapabilityScope): CapabilityScope {
  if (scope.kind === 'path' || scope.kind === 'project') return { ...scope, value: resolve(scope.value) };
  if (scope.kind !== 'browser-origin') return scope;
  return { ...scope, value: new URL(scope.value).origin };
}
