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
  approvalKey: z.string().optional(),
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
    type: z.literal('revoke'),
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
  | Omit<Extract<CapabilityAuditEvent, { type: 'revoke' }>, 'sequence'>;

type GrantInput = {
  subject: CapabilitySubject;
  capability: Capability;
  scope: CapabilityScope;
  approvalKey?: string;
  source: CapabilityGrant['source'];
  migrationKey?: string;
};

interface MigrationInput {
  sessions?: readonly {
    id: string;
    grantedDirectories?: readonly string[];
    project?: { contextDirectories: readonly string[] };
  }[];
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

  state(): Promise<CapabilityLedgerState> {
    return this.serialize(() => this.currentState());
  }

  private async currentState(): Promise<CapabilityLedgerState> {
    const events = await this.read();
    const grants = new Map<string, CapabilityGrant>();
    for (const event of events) {
      if (event.type === 'grant') grants.set(event.grant.id, { ...event.grant });
      else if (event.type === 'revoke') {
        const grant = grants.get(event.grantId);
        if (grant) grant.revokedAt = event.timestamp;
      }
    }
    return {
      grants: [...grants.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      audit: [...events].reverse(),
    };
  }

  grant(input: GrantInput): Promise<CapabilityGrant> {
    return this.serialize(() => this.createGrant(input));
  }

  private async createGrant(input: GrantInput): Promise<CapabilityGrant> {
    const normalized = { ...input, scope: normalizeScope(input.scope) };
    const existing = (await this.currentState()).grants.find(grant => !grant.revokedAt && sameGrant(grant, normalized));
    if (existing) return existing;
    const event = this.grantEvent(normalized);
    await this.append(event);
    return event.grant;
  }

  private grantEvent(input: GrantInput): Extract<AppendEvent, { type: 'grant' }> {
    const timestamp = this.now().toISOString();
    return {
      type: 'grant',
      timestamp,
      grant: {
        id: randomUUID(),
        subject: input.subject,
        capability: input.capability,
        scope: input.scope,
        createdAt: timestamp,
        ...(input.approvalKey ? { approvalKey: input.approvalKey } : {}),
        source: input.source,
      },
      ...(input.migrationKey ? { migrationKey: input.migrationKey } : {}),
    };
  }

  findActive(match: (grant: CapabilityGrant) => boolean): Promise<CapabilityGrant | undefined> {
    return this.serialize(async () =>
      (await this.currentState()).grants.find(grant => !grant.revokedAt && match(grant))
    );
  }

  async use(capability: Capability, scope: CapabilityScope, grantId?: string): Promise<void> {
    await this.serialize(() =>
      this.append({
        type: 'use',
        timestamp: this.now().toISOString(),
        capability,
        scope: normalizeScope(scope),
        ...(grantId ? { grantId } : {}),
      })
    );
  }

  async revoke(
    grantId: string,
    enforce?: (grant: CapabilityGrant) => Promise<void> | void
  ): Promise<CapabilityGrant | null> {
    return this.serialize(async () => {
      const grant = (await this.currentState()).grants.find(entry => entry.id === grantId && !entry.revokedAt);
      if (!grant) return null;
      await enforce?.(grant);
      await this.append({ type: 'revoke', timestamp: this.now().toISOString(), grantId });
      return grant;
    });
  }

  async revokeMatching(match: (grant: CapabilityGrant) => boolean): Promise<CapabilityGrant[]> {
    return this.serialize(async () => {
      const active = (await this.currentState()).grants.filter(grant => !grant.revokedAt && match(grant));
      await this.append(
        ...active.map(grant => ({ type: 'revoke' as const, timestamp: this.now().toISOString(), grantId: grant.id }))
      );
      return active;
    });
  }

  migrate(input: MigrationInput): Promise<void> {
    return this.serialize(() => this.migrateCurrent(input));
  }

  private async migrateCurrent(input: MigrationInput): Promise<void> {
    const existing = new Set(
      (await this.read()).flatMap(event => (event.type === 'grant' && event.migrationKey ? [event.migrationKey] : []))
    );
    const additions: Array<Parameters<CapabilityLedger['grant']>[0]> = [];
    const history = (await this.currentState()).grants;
    const active = history.filter(grant => !grant.revokedAt);
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
    for (const session of input.sessions ?? []) {
      for (const directory of [...(session.grantedDirectories ?? []), ...(session.project?.contextDirectories ?? [])]) {
        const value = resolve(directory);
        additions.push({
          subject: { kind: 'session', sessionId: session.id },
          capability: 'files',
          scope: { kind: 'path', value },
          source: 'migration',
          migrationKey: `session-path:${session.id}:${value}`,
        });
      }
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
    const added: Extract<AppendEvent, { type: 'grant' }>[] = [];
    for (const addition of additions) {
      if (existing.has(addition.migrationKey!)) continue;
      // A session snapshot may predate removal. Only fill missing history: a fresh
      // user grant is recorded by the native writer, never by replaying old directories.
      if (addition.subject.kind === 'session' && history.some(grant => sameMigrationGrant(grant, addition))) continue;
      if (active.some(grant => sameMigrationGrant(grant, addition))) continue;
      const event = this.grantEvent({ ...addition, scope: normalizeScope(addition.scope) });
      added.push(event);
      active.push(event.grant);
      existing.add(addition.migrationKey!);
    }
    await this.append(...added);
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

  private serialize<Result>(work: () => Promise<Result>): Promise<Result> {
    const run = this.writing.then(work);
    this.writing = run.catch(() => undefined);
    return run;
  }

  private async append(...events: AppendEvent[]): Promise<void> {
    if (events.length === 0) return;
    const current = await this.read();
    const next = [
      ...current,
      ...events.map((event, index) => ({ ...event, sequence: current.length + index }) as CapabilityAuditEvent),
    ];
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, events: next }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
    this.events = next;
  }
}

function sameMigrationGrant(grant: CapabilityGrant, addition: GrantInput): boolean {
  if (grant.capability !== addition.capability || grant.scope.kind !== addition.scope.kind) return false;
  if (grant.scope.value !== addition.scope.value || grant.subject.kind !== addition.subject.kind) return false;
  if (grant.subject.kind === 'desktop-user') return true;
  if (grant.subject.kind === 'session' && addition.subject.kind === 'session') {
    return grant.subject.sessionId === addition.subject.sessionId;
  }
  return (
    grant.subject.kind === 'project' &&
    addition.subject.kind === 'project' &&
    grant.subject.directory === addition.subject.directory
  );
}

function sameGrant(grant: CapabilityGrant, input: GrantInput): boolean {
  if (grant.capability !== input.capability || grant.approvalKey !== input.approvalKey) return false;
  if (
    grant.subject.kind !== input.subject.kind ||
    grant.scope.kind !== input.scope.kind ||
    grant.scope.value !== input.scope.value
  )
    return false;
  if (
    grant.subject.kind === 'session' &&
    (input.subject.kind !== 'session' || grant.subject.sessionId !== input.subject.sessionId)
  )
    return false;
  if (
    grant.subject.kind === 'project' &&
    (input.subject.kind !== 'project' || resolve(grant.subject.directory) !== resolve(input.subject.directory))
  )
    return false;
  return (
    grant.scope.kind !== 'browser-origin' ||
    (input.scope.kind === 'browser-origin' && grant.scope.access === input.scope.access)
  );
}

function normalizeScope(scope: CapabilityScope): CapabilityScope {
  if (scope.kind === 'path' || scope.kind === 'project') return { ...scope, value: resolve(scope.value) };
  if (scope.kind !== 'browser-origin') return scope;
  return { ...scope, value: new URL(scope.value).origin };
}
