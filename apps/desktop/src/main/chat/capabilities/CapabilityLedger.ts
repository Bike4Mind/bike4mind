import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { CAPABILITY_AUDIT_LIMIT } from '@shared/capabilities';
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
  z.object({ kind: z.literal('session'), sessionId: z.string(), scopeKey: z.string().optional() }),
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

type MigrationInput = {
  scopeKey?: string;
  sessions?: readonly {
    id: string;
    grantedDirectories?: readonly string[];
    project?: { contextDirectories: readonly string[] };
  }[];
  roots: readonly string[];
  trustedProjects: readonly string[];
  permissions: { user: PermissionRuleLists; projects: Record<string, PermissionRuleLists> };
};

export class CapabilityLedger {
  private readonly grants = new Map<string, CapabilityGrant>();
  private readonly migrationKeys = new Set<string>();
  private recent: CapabilityAuditEvent[] = [];
  private sequence = 0;
  private loaded = false;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  state(scopeKey?: string | null): Promise<CapabilityLedgerState> {
    return this.serialize(async () => {
      const state = await this.currentState();
      if (scopeKey === undefined) return state;
      const visible = (grant: CapabilityGrant) =>
        grant.subject.kind !== 'session' || (scopeKey !== null && grant.subject.scopeKey === scopeKey);
      const grantIds = new Set(state.grants.filter(visible).map(grant => grant.id));
      return {
        grants: state.grants.filter(visible),
        audit: state.audit.filter(event => {
          if (event.type === 'grant') return visible(event.grant);
          return event.grantId !== undefined && grantIds.has(event.grantId);
        }),
      };
    });
  }

  private async currentState(): Promise<CapabilityLedgerState> {
    await this.read();
    return {
      grants: [...this.grants.values()]
        .map(grant => ({ ...grant }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      audit: [...this.recent].reverse(),
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
    enforce?: (grant: CapabilityGrant) => Promise<boolean | void> | boolean | void,
    scopeKey?: string | null
  ): Promise<CapabilityGrant | null> {
    return this.serialize(async () => {
      const grant = (await this.currentState()).grants.find(entry => entry.id === grantId && !entry.revokedAt);
      if (!grant) return null;
      if (
        grant.subject.kind === 'session' &&
        scopeKey !== undefined &&
        (scopeKey === null || grant.subject.scopeKey !== scopeKey)
      )
        throw new Error('This grant belongs to another account');
      if ((await enforce?.(grant)) === false) throw new Error('Access was not removed; the grant is still active');
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
    await this.read();
    const existing = new Set(this.migrationKeys);
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
          subject: { kind: 'session', sessionId: session.id, ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}) },
          capability: 'files',
          scope: { kind: 'path', value },
          source: 'migration',
          migrationKey: `session-path:${input.scopeKey ?? ''}:${session.id}:${value}`,
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

  private async read(): Promise<void> {
    if (this.loaded) return;
    try {
      await this.load();
      this.loaded = true;
    } catch (error) {
      this.reset();
      console.error('[CapabilityLedger] Could not read audit storage; a later operation will retry', error);
      throw error;
    }
  }

  private reset(): void {
    this.grants.clear();
    this.migrationKeys.clear();
    this.recent = [];
    this.sequence = 0;
  }

  private apply(event: CapabilityAuditEvent): void {
    if (event.type === 'grant') {
      this.grants.set(event.grant.id, { ...event.grant });
      if (event.migrationKey) this.migrationKeys.add(event.migrationKey);
    } else if (event.type === 'revoke') {
      const grant = this.grants.get(event.grantId);
      if (grant) grant.revokedAt = event.timestamp;
    }
    this.recent.push(event);
    if (this.recent.length > CAPABILITY_AUDIT_LIMIT) this.recent.shift();
    this.sequence = event.sequence + 1;
  }

  private async load(): Promise<void> {
    const stream = createReadStream(this.filePath, { encoding: 'utf8' });
    let endsInNewline = true;
    stream.on('data', chunk => {
      endsInNewline = chunk.toString().endsWith('\n');
    });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        // v1 used one JSON document, sometimes pretty-printed. Convert it once,
        // atomically, before any append can mix the two storage formats.
        if (this.sequence === 0 && (line.trim() === '{' || isLegacyDocument(line))) {
          const legacy = fileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
          const temporary = `${this.filePath}.tmp`;
          await writeFile(temporary, legacy.events.map(event => JSON.stringify(event) + '\n').join(''), {
            encoding: 'utf8',
            mode: 0o600,
          });
          await rename(temporary, this.filePath);
          for (const event of legacy.events) this.apply(event);
          return;
        }
        const event = eventSchema.parse(JSON.parse(line));
        if (event.sequence !== this.sequence) throw new SyntaxError('Out of order audit sequence');
        this.apply(event);
      }
      // A process can stop after the JSON record but before its newline. Repair
      // that boundary before the next append can concatenate two valid records.
      if (!endsInNewline) await appendFile(this.filePath, '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      const quarantine = `${this.filePath}.corrupt-${this.now().getTime()}-${randomUUID()}`;
      await rename(this.filePath, quarantine);
      console.error(`[CapabilityLedger] Corrupt audit storage preserved at ${quarantine}`, error);
      this.reset();
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  private serialize<Result>(work: () => Promise<Result>): Promise<Result> {
    const run = this.writing.then(work);
    this.writing = run.catch(() => undefined);
    return run;
  }

  private async append(...events: AppendEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.read();
    const next = events.map((event, index) => ({ ...event, sequence: this.sequence + index }) as CapabilityAuditEvent);
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await appendFile(this.filePath, next.map(event => JSON.stringify(event) + '\n').join(''), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (error) {
      // An append may have written a partial tail. Reload (and quarantine if
      // necessary) on the next operation rather than appending behind it.
      this.loaded = false;
      this.reset();
      console.error('[CapabilityLedger] Could not append audit events; a later operation will retry', error);
      throw error;
    }
    for (const event of next) this.apply(event);
  }
}

function sameMigrationGrant(grant: CapabilityGrant, addition: GrantInput): boolean {
  if (grant.capability !== addition.capability || grant.scope.kind !== addition.scope.kind) return false;
  if (grant.scope.value !== addition.scope.value || grant.subject.kind !== addition.subject.kind) return false;
  if (grant.subject.kind === 'desktop-user') return true;
  if (grant.subject.kind === 'session' && addition.subject.kind === 'session') {
    return (
      grant.subject.sessionId === addition.subject.sessionId && grant.subject.scopeKey === addition.subject.scopeKey
    );
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
    (input.subject.kind !== 'session' ||
      grant.subject.sessionId !== input.subject.sessionId ||
      grant.subject.scopeKey !== input.subject.scopeKey)
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

function isLegacyDocument(line: string): boolean {
  const parsed: unknown = JSON.parse(line);
  return typeof parsed === 'object' && parsed !== null && 'version' in parsed;
}
