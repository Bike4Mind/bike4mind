// The generic half of a draft module: ids, step types, normalizing and validating. What differs per owner (step
// types, starter steps, finale, canvas) comes in through a profile.
import { z } from 'zod';
import {
  BRIDGE_STEP_ID,
  CoreTutorialVisibilitySchema,
  TUTORIAL_CARD_SIDES,
  type DraftFinaleCopy,
  type TutorialDraftContent,
  type TutorialRunModule,
  type TutorialStep,
  type TutorialTurn,
  type ValidationIssue,
} from '@bike4mind/common';
import type { TutorialCanvas, TutorialModule } from '../types';

export const DRAFT_ID = /^[a-z0-9-]{1,40}$/;
/** A draft has no repo version to bump; its revision moves on every content save instead. */
export const DRAFT_VERSION = 1;

export interface DraftCanvasProfile<TCanvas extends { turn: number }> {
  /** Fills a canvas step's params from the node the draft works on. Null leaves the step as authored. */
  normalizeStep(step: TutorialStep, nodeId: string, authored: Record<string, unknown>): TutorialStep | null;
  /** A fold that named no bottleneck gets the module's node. */
  fold(canvas: TCanvas, nodeId: string): TCanvas;
}

export interface DraftProfile<TCanvas extends { turn: number } = { turn: number }> {
  /** Step types an author may use, each with the params schema it must pass. */
  params: Readonly<Record<string, z.ZodType>>;
  /** Step types that send their turn's prompt. */
  sendTypes: readonly string[];
  /** The step type whose `params.fileName` is filled from the sheet name. */
  attachType: string;
  starterSteps(transcript: readonly TutorialTurn[]): TutorialStep[];
  defaultFinale: DraftFinaleCopy;
  isRepoModuleId(id: string): boolean;
  /** Steps a learner walks after the draft's own; core returns them unchanged. */
  withFinale(
    steps: TutorialStep[],
    content: Pick<TutorialDraftContent, 'transcript' | 'finale'>
  ): readonly TutorialStep[];
  validateModule(
    module: TutorialModule,
    context: { canvasSolve?: { nodeId: string; turn: number } }
  ): ValidationIssue[];
  /** Present for an owner whose drafts work on a canvas; makes `canvasNodeId` required. */
  canvas?: DraftCanvasProfile<TCanvas>;
  /** True for core: a draft without `visibility` breaks the `draft-visibility` rule. */
  requireVisibility: boolean;
}

export interface DraftServeState {
  revision: number;
  enabled: boolean;
}

const PRINTABLE_LINE = /^[\x20-\x7e]*$/;

const StepShape = z
  .object({
    id: z
      .string()
      .regex(DRAFT_ID)
      .refine(id => id !== BRIDGE_STEP_ID, 'the finale step id is reserved'),
    type: z.string(),
    title: z.string().max(120).optional(),
    body: z.string().min(1).max(1000),
    doneBody: z.string().max(1000).optional(),
    anchor: z.string().max(200).optional(),
    anchorScope: z.string().max(200).optional(),
    placement: z.enum(TUTORIAL_CARD_SIDES).optional(),
    avoid: z.string().max(300).optional(),
    turn: z.number().int().min(0).max(200).optional(),
    prompt: z.string().max(8000).optional(),
    action: z.string().max(40).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const DraftStepsSchema = z.array(StepShape).max(60);

export function createDraftCore<TCanvas extends { turn: number }>(profile: DraftProfile<TCanvas>) {
  const stepTypes = Object.keys(profile.params);
  const DraftStepSchema = StepShape.extend({
    type: z.string().refine(type => stepTypes.includes(type), `not a step type a draft may use`),
  });

  /** Fills what an author never types: each sent prompt from its turn, the sheet name, and the owner's canvas params. */
  function normalizeDraftSteps(
    content: Pick<TutorialDraftContent<TCanvas>, 'steps' | 'transcript' | 'sheet' | 'canvasNodeId'>
  ): TutorialStep[] {
    const nodeId = content.canvasNodeId ?? '';
    return content.steps.map(({ turn, prompt: _prompt, params, ...authored }) => {
      const sent =
        profile.sendTypes.includes(authored.type) && turn !== undefined
          ? { turn, prompt: content.transcript[turn]?.prompt ?? '' }
          : {};
      const step: TutorialStep = { ...authored, ...sent };
      if (authored.type === profile.attachType) {
        return { ...step, params: { fileName: content.sheet?.name ?? '' } };
      }
      const custom = profile.canvas?.normalizeStep(step, nodeId, (params ?? {}) as Record<string, unknown>);
      return custom ?? step;
    });
  }

  function draftRules(content: TutorialDraftContent<TCanvas>): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const add = (rule: string, message: string, stepId?: string) =>
      issues.push(stepId === undefined ? { rule, message } : { stepId, rule, message });
    if (!DRAFT_ID.test(content.moduleId)) add('draft-id', `"${content.moduleId}" is not a lowercase id`);
    if (profile.isRepoModuleId(content.moduleId)) add('draft-id', 'a repo module already has this id');
    if (!content.title.trim() || !PRINTABLE_LINE.test(content.title)) add('draft-title', 'needs a plain ASCII title');
    if (!content.pitch.trim() || !PRINTABLE_LINE.test(content.pitch)) add('draft-title', 'needs a plain ASCII pitch');
    if (!content.finale.title.trim() || !content.finale.body.trim())
      add('draft-finale', 'the finale needs a title and body');
    if (content.transcript.length === 0) add('draft-finale', 'the opening message is missing');
    if (profile.canvas && !content.canvasNodeId) {
      add('draft-canvas-node', 'pick the canvas node the setup and race work on');
    }
    if (profile.requireVisibility && !CoreTutorialVisibilitySchema.safeParse(content.visibility).success) {
      add('draft-visibility', 'choose who may run this tutorial: everyone, or holders of one entitlement');
    }
    if (content.steps.some(s => s.type === profile.attachType) && !content.sheet) {
      add('draft-sheet', 'a step attaches the sheet, so upload one');
    }
    content.steps.forEach((step, i) => {
      const parsed = DraftStepSchema.safeParse(step);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        add('draft-step', `step ${i + 1}: ${issue?.path.join('.') || 'step'} ${issue?.message ?? ''}`.trim(), step.id);
        return;
      }
      const params = profile.params[parsed.data.type].safeParse(step.params);
      if (!params.success) {
        const issue = params.error.issues[0];
        add(
          'draft-params',
          `${step.type}: ${issue?.path.join('.') || 'params'} ${issue?.message ?? ''}`.trim(),
          step.id
        );
      }
    });
    return issues;
  }

  /** The draft as the page runs it and as the server plays it, its finale appended. */
  function draftModule(
    content: TutorialDraftContent<TCanvas>,
    { revision, enabled }: DraftServeState
  ): { door: TutorialRunModule; module: TutorialModule } {
    const steps = [...profile.withFinale(normalizeDraftSteps(content), content)];
    const canvasSolve =
      content.canvas && content.canvasNodeId ? { nodeId: content.canvasNodeId, turn: content.canvas.turn } : undefined;
    const canvas =
      content.canvas && canvasSolve && profile.canvas
        ? profile.canvas.fold(content.canvas, canvasSolve.nodeId)
        : content.canvas;
    const door: TutorialRunModule = {
      id: content.moduleId,
      title: content.title,
      pitch: content.pitch,
      version: DRAFT_VERSION,
      revision,
      enabled,
      created: true,
      steps,
      ...(canvasSolve && { canvasSolve }),
    };
    const served: TutorialModule = {
      id: content.moduleId,
      title: content.title,
      pitch: content.pitch,
      openingPrompt: content.transcript[0]?.prompt ?? '',
      ...(content.sheet && { sheet: content.sheet }),
      version: DRAFT_VERSION,
      revision,
      enabled,
      steps,
      transcript: content.transcript,
      ...(canvas && { canvas: canvas as unknown as TutorialCanvas }),
      ...(canvasSolve && { canvasSolve }),
      created: true,
    };
    return { door, module: served };
  }

  /** Every rule the draft breaks: its own (ids, step types, params) and every generic rule a repo module holds. */
  function validateDraft(content: TutorialDraftContent<TCanvas>): ValidationIssue[] {
    const own = draftRules(content);
    const { door, module: served } = draftModule(content, { revision: 0, enabled: true });
    return [...own, ...profile.validateModule(served, { canvasSolve: door.canvasSolve })];
  }

  return { normalizeDraftSteps, draftModule, validateDraft, stepTypes };
}
export type DraftCore<TCanvas extends { turn: number } = { turn: number }> = ReturnType<
  typeof createDraftCore<TCanvas>
>;
