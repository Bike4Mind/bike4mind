// The wire shapes a made tutorial shares between the drafts route and its card, and the exported bundle.
import { z } from 'zod';
import type { TutorialTurn } from './capture';
import { MODULE_BUNDLE_FORMAT } from './overrideUnits';
import type { TutorialStep } from './tutorial';
import type { ValidationIssue } from './validation';
import { CoreTutorialVisibilitySchema, type CoreTutorialVisibility } from './visibility';

export interface DraftFinaleCopy {
  title: string;
  body: string;
}

/** What an admin captures and authors. The server fills each step's prompt and params from it. */
export interface TutorialDraftContent<TCanvas = unknown> {
  moduleId: string;
  title: string;
  pitch: string;
  transcript: TutorialTurn[];
  canvas?: TCanvas;
  sheet?: { name: string; csv: string };
  steps: TutorialStep[];
  /** The canvas node the setup and race steps work on. */
  canvasNodeId?: string;
  finale: DraftFinaleCopy;
  /** Who may run the draft. Required of a core draft; an owner whose drafts have no such choice leaves it out. */
  visibility?: CoreTutorialVisibility;
}

export interface TutorialDraftView {
  moduleId: string;
  title: string;
  pitch: string;
  sourceSessionId: string;
  revision: number;
  contentSeq: number;
  approved: boolean;
  enabled: boolean;
  content: TutorialDraftContent;
  /** The steps as a learner walks them, the generic finale included: what approval approves. */
  preview: readonly TutorialStep[];
  issues: ValidationIssue[];
  lastChange: { field: string; actorId: string; reason: string; at: string } | null;
}

export interface TutorialDraftChoices {
  anchors: string[];
  anchorScopes: string[];
  avoids: string[];
  canvasTabs: string[];
  stepTypes: string[];
  /** True when a draft must be given a visibility, so the card knows to ask. */
  visibility: boolean;
}

export interface TutorialDraftsResponse {
  drafts: TutorialDraftView[];
  choices: TutorialDraftChoices;
}

const TurnSchema = z.object({ prompt: z.string(), reply: z.string() }).passthrough();

const ContentSchema = z.object({
  moduleId: z.string(),
  title: z.string(),
  pitch: z.string(),
  transcript: z.array(TurnSchema),
  canvas: z
    .object({ turn: z.number().int().min(0), doc: z.object({ nodes: z.array(z.unknown()) }).passthrough() })
    .passthrough()
    .optional(),
  sheet: z.object({ name: z.string(), csv: z.string() }).optional(),
  steps: z.array(z.record(z.string(), z.unknown())),
  canvasNodeId: z.string().optional(),
  finale: z.object({ title: z.string(), body: z.string() }),
  visibility: CoreTutorialVisibilitySchema.optional(),
});

export const ModuleBundleSchema = z.object({
  format: z.literal(MODULE_BUNDLE_FORMAT),
  /** The package that exported it; a bundle without one predates the field. */
  owner: z.string().min(1).optional(),
  moduleId: z.string(),
  exportedAt: z.string().optional(),
  content: ContentSchema,
});

export interface TutorialModuleBundle {
  format: typeof MODULE_BUNDLE_FORMAT;
  owner?: string;
  moduleId: string;
  exportedAt: string;
  content: TutorialDraftContent;
}
