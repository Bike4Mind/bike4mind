import { randomUUID } from 'node:crypto';
import { SOUND_EFFECTS_MAX_INPUT_CHARS } from '@bike4mind/common';
import type { StudioAsset, StudioJob, StudioProvenance } from '@shared/studio';
import {
  studioCreateSchema,
  studioDraftSchema,
  studioPageRequestSchema,
  type StudioRecordsPage,
  type StudioDraft,
  type StudioLiveState,
  type StudioReview,
} from '@shared/studioIpc';
import type { SessionStore } from '../SessionStore';
import type { AttachmentStore } from '../AttachmentStore';
import { StudioWorkspaceStore } from './StudioWorkspaceStore';
import { boundedText, ContextCollector, hash } from './context/collector';
import { createContextFileReader } from './context/fileReader';
import { ContextPreparationService, type PreparedDraft } from './context/preparation';
import type { ContextRequest, ContextSnapshot } from './context/types';
import type { StudioCatalog } from '@shared/studioIpc';
import type { StudioGenerationRequest } from './generation/StudioGenerationService';

export interface StudioGenerationPort {
  submit(
    sessionId: string,
    draft: StudioDraft,
    prompt: string,
    provenance: StudioProvenance,
    authorize: () => Promise<boolean>,
    planned?: StudioGenerationRequest
  ): Promise<StudioJob>;
  recover(sessionId: string): Promise<unknown>;
}

interface ReviewRecord {
  scope: string;
  draft: string;
  prepared: PreparedDraft;
  expires: number;
  planned?: StudioGenerationRequest;
}

export class StudioLiveService {
  private readonly reviews = new Map<string, ReviewRecord>();
  private readonly pending = new Set<AbortController>();
  private readonly collector: ContextCollector;
  private readonly preparing: ContextPreparationService;

  constructor(
    private readonly deps: {
      sessions: SessionStore;
      workspaces: StudioWorkspaceStore;
      attachments: AttachmentStore;
      roots(sessionId: string): Promise<readonly string[]>;
      prepare(sessionId: string, system: string, input: string, signal: AbortSignal): Promise<string>;
      available(): boolean;
      unavailableKinds?(): Promise<string[]>;
      catalog?(): Promise<StudioCatalog>;
      plan?(
        draft: StudioDraft,
        prompt: string
      ): Promise<{ request: StudioGenerationRequest; estimatedCredits: number | null }>;
      generation: StudioGenerationPort;
      changed(event: { sessionId: string; workspaceId: string }): void;
    }
  ) {
    const sessions = deps.sessions;
    this.collector = new ContextCollector({
      scopeKey: () => sessions.scopeKey() ?? '',
      listSessions: async (requester, limit) => (await this.family(requester)).slice(0, limit),
      readSession: async (requester, id) => {
        const scope = sessions.scopeKey();
        const [source, target] = await Promise.all([
          sessions.resolveStudioWorkspace(requester, scope),
          sessions.resolveStudioWorkspace(id, scope),
        ]);
        if (!source || source.workspaceId !== target?.workspaceId || scope !== sessions.scopeKey())
          return { status: 'denied' };
        const session = await sessions.get(id);
        return session ? { status: 'ok', value: session } : { status: 'missing' };
      },
      readAttachment: async (_requester, owner, attachment, maxBytes, signal) => {
        signal.throwIfAborted();
        const session = await sessions.get(owner);
        if (!session?.messages.some(message => message.attachments?.some(item => item.id === attachment.id)))
          return { status: 'denied' };
        if (attachment.mediaType === 'application/pdf') {
          const pdf = await deps.attachments.readPdfText(owner, attachment.id);
          return pdf
            ? {
                status: 'ok',
                value: { text: boundedText(pdf.text, maxBytes), truncated: Buffer.byteLength(pdf.text) > maxBytes },
              }
            : { status: 'unavailable' };
        }
        if (!attachment.mediaType.startsWith('text/')) return { status: 'unavailable' };
        const bytes = await deps.attachments.read(owner, attachment.id);
        if (!bytes) return { status: 'missing' };
        const text = boundedText(bytes.toString('utf8'), maxBytes);
        return { status: 'ok', value: { text, truncated: bytes.length > maxBytes } };
      },
      readFile: createContextFileReader(deps.roots),
    });
    this.preparing = new ContextPreparationService(this.collector, {
      prepare: (input, signal) =>
        deps.prepare(
          input.context.sessionId,
          input.system,
          JSON.stringify({
            kind: input.kind,
            instruction: input.instruction,
            context: input.context,
          }),
          signal
        ),
    });
  }

  invalidate(): void {
    this.reviews.clear();
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }

  async family(sessionId: string) {
    const scope = this.deps.sessions.scopeKey();
    const identity = await this.deps.sessions.resolveStudioWorkspace(sessionId, scope);
    if (!identity) throw new Error('Studio session is unavailable.');
    const all = await this.deps.sessions.list();
    const current = all.find(session => session.id === sessionId);
    if (!current) throw new Error('Studio session is unavailable.');
    const members = [current];
    for (const session of all) {
      if (session.id === sessionId) continue;
      const workspace = session.studioWorkspaceId
        ? { workspaceId: session.studioWorkspaceId }
        : await this.deps.sessions.resolveStudioWorkspace(session.id, scope);
      if (scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
      if (workspace?.workspaceId === identity.workspaceId) members.push(session);
      if (members.length >= 256) break;
    }
    return members;
  }

  async page(raw: unknown): Promise<StudioRecordsPage> {
    const request = studioPageRequestSchema.parse(raw);
    const identity = await this.identity(request.sessionId);
    const page =
      request.collection === 'assets'
        ? await this.deps.workspaces.listAssets(request.sessionId, { cursor: request.cursor })
        : await this.deps.workspaces.listJobs(request.sessionId, { cursor: request.cursor });
    if (!page || identity.scope !== this.deps.sessions.scopeKey()) throw new Error('Studio session is unavailable.');
    return { collection: request.collection, ...page } as StudioRecordsPage;
  }

  async assertDeletable(sessionId: string): Promise<void> {
    const scope = this.deps.sessions.scopeKey();
    if (!(await this.deps.sessions.get(sessionId))) return;
    if ((await this.family(sessionId)).length > 1) return;
    let cursor: string | undefined;
    do {
      const page = await this.deps.workspaces.listJobs(sessionId, { cursor });
      if (!page || scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
      if (page.items.some(job => !['completed', 'failed', 'cancelled'].includes(job.state) && !job.recoveryExpired))
        throw new Error(
          'This is the last session for unresolved Studio jobs. Keep it until jobs settle or the 7-day automatic recovery period ends.'
        );
      cursor = page.nextCursor;
    } while (cursor);
  }

  private async identity(sessionId: string) {
    const scope = this.deps.sessions.scopeKey();
    const [session, workspace] = await Promise.all([
      this.deps.sessions.get(sessionId),
      this.deps.sessions.resolveStudioWorkspace(sessionId, scope),
    ]);
    if (!scope || scope !== this.deps.sessions.scopeKey() || !session || !workspace)
      throw new Error('Studio session is unavailable.');
    const roots = await this.deps.roots(sessionId);
    if (scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
    return {
      scope,
      session,
      workspace,
      revision: hash(JSON.stringify({ scope, model: session.model, roots, workspace })),
    };
  }

  async get(sessionId: string): Promise<StudioLiveState> {
    const identity = await this.identity(sessionId);
    const [workspace, sessions] = await Promise.all([this.deps.workspaces.get(sessionId), this.family(sessionId)]);
    const unavailableKinds = await this.deps.unavailableKinds?.();
    const catalog = await this.deps.catalog?.();
    if (!workspace || identity.scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
    return {
      sessionId,
      revision: identity.revision,
      workspace,
      sessions: sessions.slice(0, 256).map(({ id, title }) => ({ id, title })),
      available: this.deps.available(),
      unavailableKinds,
      catalog,
    };
  }

  private async context(draft: StudioDraft): Promise<ContextRequest> {
    if (draft.selection.mode === 'none')
      return { sessionId: draft.sessionId, selection: { kind: 'explicit', sessionIds: [] } };
    const family = await this.family(draft.sessionId);
    const selected =
      draft.selection.mode === 'custom' ? (draft.selection.sessionIds ?? []) : family.map(session => session.id);
    if (selected.some(id => !family.some(session => session.id === id)))
      throw new Error('Context session is outside this Studio family.');
    return {
      sessionId: draft.sessionId,
      selection:
        draft.selection.mode === 'custom'
          ? { kind: 'explicit', sessionIds: draft.selection.sessionIds ?? [] }
          : draft.selection.mode === 'session-family'
            ? { kind: 'explicit', sessionIds: selected }
            : { kind: 'current' },
      files: draft.selection.files,
    };
  }

  private async validate(draft: StudioDraft) {
    const identity = await this.identity(draft.sessionId);
    if (identity.revision !== draft.revision || identity.workspace.workspaceId !== draft.workspaceId)
      throw new Error('Studio context changed. Review again.');
    return identity;
  }

  async prepare(raw: unknown): Promise<StudioReview> {
    const draft = studioDraftSchema.parse(raw);
    if (draft.kind === 'sound-effect' && draft.prompt.length > SOUND_EFFECTS_MAX_INPUT_CHARS)
      throw new Error(`Keep the sound description within ${SOUND_EFFECTS_MAX_INPUT_CHARS} characters.`);
    const identity = await this.validate(draft);
    const controller = new AbortController();
    this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      await this.deps.plan?.(draft, draft.prompt);
      const context = await this.context(draft);
      if (identity.scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
      const prepared = await this.preparing.prepare(
        {
          context,
          kind: draft.kind === 'speech' ? 'script' : 'prompt',
          instruction: draft.prompt,
          ...(draft.kind === 'sound-effect' ? { maxCharacters: SOUND_EFFECTS_MAX_INPUT_CHARS } : {}),
        },
        controller.signal
      );
      await this.validate(draft);
      const plan = await this.deps.plan?.(draft, prepared.text);
      if (identity.scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
      for (const [id, record] of this.reviews) if (record.expires < Date.now()) this.reviews.delete(id);
      if (this.reviews.size >= 64) this.reviews.delete(this.reviews.keys().next().value!);
      const id = randomUUID();
      this.reviews.set(id, {
        scope: identity.scope,
        draft: JSON.stringify(draft),
        prepared,
        planned: plan?.request,
        expires: Date.now() + 15 * 60_000,
      });
      const sessions = await this.deps.sessions.list();
      if (identity.scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
      return {
        id,
        preparedPrompt: prepared.text,
        count: draft.kind === 'image' ? (draft.settings.count ?? 1) : 1,
        estimatedCredits: plan?.estimatedCredits ?? null,
        sources: prepared.context.sessionIds.map(sessionId => ({
          sessionId,
          title: sessions.find(s => s.id === sessionId)?.title ?? sessionId,
        })),
        exclusions: prepared.context.issues
          .filter(issue => issue.reason !== 'truncated')
          .map(issue => `${issue.source}: ${issue.reason}`),
        truncation: prepared.context.issues.filter(issue => issue.reason === 'truncated').map(issue => issue.source),
        warnings: ['Creating media uses credits. Review the prepared text before creating.'],
      };
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }

  async create(raw: unknown): Promise<void> {
    const request = studioCreateSchema.parse(raw);
    const record = this.reviews.get(request.reviewId);
    this.reviews.delete(request.reviewId);
    const identity = await this.validate(request.draft);
    if (
      !record ||
      record.scope !== identity.scope ||
      record.expires < Date.now() ||
      record.draft !== JSON.stringify(request.draft)
    )
      throw new Error('Review expired. Prepare and review again.');
    const controller = new AbortController();
    this.pending.add(controller);
    try {
      const current = await this.collector.collect(await this.context(request.draft), controller.signal);
      if (current.sha256 !== record.prepared.context.sha256)
        throw new Error('Context changed. Prepare and review again.');
      await this.validate(request.draft);
      if (record.scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
      await this.deps.generation.submit(
        request.draft.sessionId,
        request.draft,
        request.preparedPrompt,
        provenance(current),
        async () => {
          await this.validate(request.draft);
          controller.signal.throwIfAborted();
          const latest = await this.collector.collect(await this.context(request.draft), controller.signal);
          return record.scope === this.deps.sessions.scopeKey() && latest.sha256 === current.sha256;
        },
        record.planned
      );
      if (record.scope === this.deps.sessions.scopeKey())
        this.deps.changed({ sessionId: request.draft.sessionId, workspaceId: identity.workspace.workspaceId });
    } finally {
      this.pending.delete(controller);
    }
  }

  async asset(sessionId: string, assetId: string): Promise<StudioAsset> {
    const identity = await this.identity(sessionId);
    const asset = await this.deps.workspaces.getAsset(sessionId, assetId);
    if (identity.scope !== this.deps.sessions.scopeKey()) throw new Error('Account changed.');
    if (asset) return asset;
    throw new Error('Studio asset is unavailable.');
  }
}

function provenance(context: ContextSnapshot): StudioProvenance {
  return {
    preparedAt: new Date().toISOString(),
    sessions: context.sessionIds.map(sessionId => ({
      sessionId,
      messageIds: context.entries.flatMap(entry =>
        entry.source.kind === 'message' && entry.source.sessionId === sessionId ? [entry.source.messageId] : []
      ),
    })),
    files: context.entries.flatMap(entry =>
      entry.source.kind === 'file' ? [{ path: entry.source.path, sha256: entry.sha256 }] : []
    ),
    warnings: context.issues.map(issue => `${issue.source}: ${issue.reason}`),
  };
}
