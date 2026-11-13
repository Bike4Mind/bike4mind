// List, capture, save, sheet, approve, enable and delete over one owner's draft rows. Every content write moves
// the sequence and revision, drops the approval and switches the draft off, so learners only ever run content an
// admin approved in the preview.
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CoreTutorialVisibilitySchema,
  type CoreTutorialVisibility,
  type TutorialDraftChoices,
  type TutorialDraftContent,
  type TutorialDraftsResponse,
  type TutorialDraftView,
  type TutorialStep,
  type ValidationIssue,
} from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { assertKnownEntitlements } from '@bike4mind/server-utils/entitlements/partnerRules';
import type { TutorialModels } from '../models';
import { captureSession, type CaptureDeps, type CaptureHooks } from './capture';
import { DRAFT_ID, DraftStepsSchema, type DraftCore, type DraftProfile } from './draftCore';
import { draftContentOf, draftIsApproved, servableDraft, servableDrafts, type TutorialDraftRow } from './servable';

const reason = z.string().trim().min(1).max(500);
const moduleId = z.string().regex(DRAFT_ID);
const contentSeq = z.number().int().min(0);
const visibility = CoreTutorialVisibilitySchema.optional();

export const DraftPostSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('capture'),
    sessionId: z.string().min(1).max(64),
    moduleId,
    title: z.string().trim().min(1).max(120),
    canvasTurn: z.number().int().min(1).max(200).optional(),
    visibility,
    reason: reason.optional(),
  }),
  z.object({
    action: z.literal('save'),
    moduleId,
    contentSeq,
    reason,
    title: z.string().max(120).optional(),
    pitch: z.string().max(300).optional(),
    steps: DraftStepsSchema.optional(),
    replies: z
      .array(z.object({ turn: z.number().int().min(0), reply: z.string().min(1).max(20000) }))
      .max(200)
      .optional(),
    attachTurn: z.number().int().min(0).nullable().optional(),
    canvasNodeId: z.string().min(1).max(200).optional(),
    finale: z.object({ title: z.string().max(120), body: z.string().max(1000) }).optional(),
    visibility,
  }),
  z.object({
    action: z.literal('sheet'),
    moduleId,
    contentSeq,
    reason,
    name: z.string().max(200),
    csv: z.string().max(200_000),
  }),
  z.object({ action: z.literal('approve'), moduleId, contentSeq, reason }),
  z.object({ action: z.literal('enable'), moduleId, contentSeq, reason, enabled: z.boolean() }),
  z.object({ action: z.literal('delete'), moduleId, contentSeq, reason }),
]);
export type DraftPostBody = z.infer<typeof DraftPostSchema>;

export interface DraftStoreOptions<TCanvas extends { turn: number }> {
  models: Pick<TutorialModels, 'Draft' | 'OverrideChange'>;
  core: DraftCore<TCanvas>;
  profile: DraftProfile<TCanvas>;
  capture: { deps: CaptureDeps; hooks: CaptureHooks<TCanvas> };
  choices: Omit<TutorialDraftChoices, 'stepTypes' | 'visibility'>;
  validateSheet(sheet: { name: string; csv: string }): ValidationIssue[];
}

type Outcome = { status: number; body: unknown } | null;
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Outcome => ({
  status,
  body: { error, ...extra },
});
const CONFLICT = fail(409, 'The draft changed while you edited it; reload and try again', { code: 'STALE' });

/** The entitlement key is a free string, so a typo would leave the draft visible to admins and developers only. */
function refuseUnknownEntitlement(visible: CoreTutorialVisibility | undefined): Outcome {
  if (!visible || !('entitlement' in visible) || !visible.entitlement) return null;
  try {
    assertKnownEntitlements([visible.entitlement]);
    return null;
  } catch (error) {
    return fail(400, (error as Error).message, { code: 'UNKNOWN_ENTITLEMENT' });
  }
}

export function draftStore<TCanvas extends { turn: number }>({
  models,
  core,
  profile,
  capture,
  choices,
  validateSheet,
}: DraftStoreOptions<TCanvas>) {
  const CHOICES: TutorialDraftChoices = {
    ...choices,
    stepTypes: [...core.stepTypes],
    visibility: profile.requireVisibility,
  };
  const contentOf = (row: TutorialDraftRow) => draftContentOf<TCanvas>(row, profile.defaultFinale);

  function viewOf(
    row: TutorialDraftRow,
    change?: { field: string; actorId: string; reason: string; createdAt: Date }
  ): TutorialDraftView {
    const content = contentOf(row);
    return {
      moduleId: row.moduleId,
      title: row.title,
      pitch: row.pitch ?? '',
      sourceSessionId: row.sourceSessionId,
      revision: row.revision,
      contentSeq: row.contentSeq,
      approved: draftIsApproved(row),
      enabled: row.enabled,
      content,
      preview: core.draftModule(content, { revision: row.revision, enabled: row.enabled }).door.steps,
      issues: core.validateDraft(content),
      lastChange: change
        ? { field: change.field, actorId: change.actorId, reason: change.reason, at: change.createdAt.toISOString() }
        : null,
    };
  }

  async function list(): Promise<TutorialDraftsResponse> {
    const rows = await models.Draft.find({}, { _id: 0, __v: 0 }).sort({ createdAt: 1 }).lean<TutorialDraftRow[]>();
    const changes = rows.length
      ? await models.OverrideChange.aggregate<{
          _id: string;
          field: string;
          actorId: string;
          reason: string;
          createdAt: Date;
        }>([
          { $match: { moduleId: { $in: rows.map(r => r.moduleId) }, field: /^draft:/ } },
          { $sort: { moduleId: 1, createdAt: -1 } },
          {
            $group: {
              _id: '$moduleId',
              field: { $first: '$field' },
              actorId: { $first: '$actorId' },
              reason: { $first: '$reason' },
              createdAt: { $first: '$createdAt' },
            },
          },
        ])
      : [];
    const changeOf = new Map(changes.map(c => [c._id, c]));
    return { drafts: rows.map(row => viewOf(row, changeOf.get(row.moduleId))), choices: CHOICES };
  }

  /** The draft's content after a save: replies replaced by turn, the sheet turn moved, steps refilled. */
  function savedContent(
    current: TutorialDraftContent<TCanvas>,
    body: Extract<DraftPostBody, { action: 'save' }>
  ): TutorialDraftContent<TCanvas> {
    const replyOf = new Map((body.replies ?? []).map(r => [r.turn, r.reply]));
    const transcript = current.transcript.map((turn, i) => {
      const { attachSheet: _attach, ...rest } = turn;
      const attach = body.attachTurn === undefined ? turn.attachSheet : body.attachTurn === i;
      return { ...rest, ...(replyOf.has(i) && { reply: replyOf.get(i)! }), ...(attach && { attachSheet: true }) };
    });
    const next: TutorialDraftContent<TCanvas> = {
      ...current,
      ...(body.title !== undefined && { title: body.title }),
      ...(body.pitch !== undefined && { pitch: body.pitch }),
      ...(body.canvasNodeId !== undefined && { canvasNodeId: body.canvasNodeId }),
      ...(body.finale && { finale: body.finale }),
      ...(body.visibility && { visibility: body.visibility }),
      transcript,
      steps: (body.steps as TutorialStep[] | undefined) ?? current.steps,
    };
    return { ...next, steps: core.normalizeDraftSteps(next) };
  }

  async function audit(
    session: unknown,
    id: string,
    field: string,
    before: unknown,
    after: unknown,
    actorId: string,
    why: string
  ) {
    await models.OverrideChange.create(
      [
        {
          moduleId: id,
          field: `draft:${field}`,
          before: before === undefined ? null : JSON.stringify(before),
          after: after === undefined ? null : JSON.stringify(after),
          actorId,
          reason: why,
        },
      ],
      { session: session as never, ordered: true }
    );
  }

  /** A content write: moves the sequence and revision, drops the approval and switches the draft off. */
  async function writeContent(
    body: { moduleId: string; contentSeq: number; reason: string },
    set: Record<string, unknown>,
    field: string,
    summary: unknown,
    actorId: string
  ): Promise<Outcome> {
    const written = await withTransaction(async session => {
      const update = await models.Draft.findOneAndUpdate(
        { moduleId: body.moduleId, contentSeq: body.contentSeq },
        {
          $set: { ...set, enabled: false, updatedBy: actorId },
          $unset: { approvedSeq: 1 },
          $inc: { contentSeq: 1, revision: 1 },
        },
        { returnDocument: 'after', session }
      );
      if (!update) return false;
      await audit(session, body.moduleId, field, { contentSeq: body.contentSeq }, summary, actorId, body.reason);
      return true;
    });
    return written ? null : CONFLICT;
  }

  async function act(body: DraftPostBody, actorId: string): Promise<Outcome> {
    if (body.action === 'capture') {
      if (profile.requireVisibility && !body.visibility) {
        return fail(400, 'Choose who may run this tutorial before capturing it', { code: 'VISIBILITY_REQUIRED' });
      }
      const unknown = refuseUnknownEntitlement(body.visibility);
      if (unknown) return unknown;
      const captured = await captureSession(core, profile, capture.deps, capture.hooks, actorId, body);
      if (!captured.ok) return fail(captured.status, captured.error, captured.code ? { code: captured.code } : {});
      const { content } = captured;
      // Never 0: a learner's saved walk names the revision, so a recapture under a deleted draft's id must not
      // reuse one that walk could still match.
      const seed = Date.now();
      const created = await withTransaction(async session => {
        await models.Draft.create(
          [
            {
              ...content,
              sourceSessionId: body.sessionId,
              revision: seed,
              contentSeq: seed,
              enabled: false,
              capturedBy: actorId,
              updatedBy: actorId,
            },
          ],
          { session }
        );
        const summary = { sessionId: body.sessionId, turns: content.transcript.length };
        await audit(session, body.moduleId, 'capture', undefined, summary, actorId, body.reason ?? 'captured');
        return true;
      }).catch((error: { code?: number }) => {
        if (error?.code === 11000) return false;
        throw error;
      });
      return created ? null : fail(409, 'A draft already has this id', { code: 'ID_TAKEN' });
    }

    const row = await models.Draft.findOne({ moduleId: body.moduleId }, { _id: 0, __v: 0 }).lean<TutorialDraftRow>();
    if (!row) return fail(404, 'No such draft');

    if (body.action !== 'delete' && body.contentSeq !== row.contentSeq) return CONFLICT;

    if (body.action === 'delete') {
      const deleted = await withTransaction(async session => {
        const result = await models.Draft.deleteOne(
          { moduleId: body.moduleId, contentSeq: body.contentSeq },
          { session }
        );
        if (!result.deletedCount) return false;
        const before = {
          contentSeq: row.contentSeq,
          enabled: row.enabled,
          title: row.title,
          content: contentOf(row),
        };
        await audit(session, body.moduleId, 'delete', before, undefined, actorId, body.reason);
        return true;
      });
      return deleted ? null : CONFLICT;
    }

    if (body.action === 'save') {
      const unknown = refuseUnknownEntitlement(body.visibility);
      if (unknown) return unknown;
      const current = contentOf(row);
      const next = savedContent(current, body);
      const { moduleId: _id, ...set } = next;
      const changed = Object.keys(set).filter(
        k => !isDeepStrictEqual(set[k as keyof typeof set], current[k as keyof typeof current])
      );
      if (changed.length === 0) return null;
      return writeContent(body, set, 'content', { fields: changed }, actorId);
    }
    if (body.action === 'sheet') {
      const sheet = { name: body.name.trim(), csv: body.csv };
      const rules = validateSheet(sheet);
      if (rules.length > 0) return fail(422, 'The sheet breaks a tutorial rule', { rules });
      const content = { ...contentOf(row), sheet };
      const set = { sheet, steps: core.normalizeDraftSteps(content) };
      return writeContent(body, set, 'sheet', { name: sheet.name, bytes: sheet.csv.length }, actorId);
    }

    const issues = core.validateDraft(contentOf(row));
    if (body.action === 'approve') {
      if (issues.length > 0) return fail(422, 'Fix every rule before approving', { rules: issues });
      const written = await withTransaction(async session => {
        const update = await models.Draft.findOneAndUpdate(
          { moduleId: body.moduleId, contentSeq: body.contentSeq },
          { $set: { approvedSeq: body.contentSeq, updatedBy: actorId } },
          { session }
        );
        if (!update) return false;
        await audit(session, body.moduleId, 'approve', row.approvedSeq, body.contentSeq, actorId, body.reason);
        return true;
      });
      return written ? null : CONFLICT;
    }

    if (body.enabled && (!draftIsApproved(row) || issues.length > 0)) {
      return fail(422, 'Approve the draft in the preview before switching it on', {
        code: 'NOT_APPROVED',
        rules: issues,
      });
    }
    const written = await withTransaction(async session => {
      const update = await models.Draft.findOneAndUpdate(
        { moduleId: body.moduleId, contentSeq: body.contentSeq },
        { $set: { enabled: body.enabled, updatedBy: actorId } },
        { session }
      );
      if (!update) return false;
      await audit(session, body.moduleId, 'enabled', row.enabled, body.enabled, actorId, body.reason);
      return true;
    });
    return written ? null : CONFLICT;
  }

  return {
    list,
    act,
    /** Approved, switched on, still valid, and not shadowed by a repo module. */
    async servable() {
      const rows = await models.Draft.find({ enabled: true }, { _id: 0, __v: 0 }).lean<TutorialDraftRow[]>();
      return servableDrafts(core, profile, rows);
    },
    /** The one servable draft with this id, for the chat path; one indexed read. */
    async servableById(id: string) {
      const row = await models.Draft.findOne(
        { moduleId: id, enabled: true },
        { _id: 0, __v: 0 }
      ).lean<TutorialDraftRow>();
      const draft = row ? servableDraft(core, profile, row) : null;
      return draft && { module: draft.module, row: draft.row };
    },
  };
}
