// Capturing an admin's own session as a draft module. The effects sit behind `deps`, so the refusals are testable
// without a database, and what differs per owner (surface, scrub, canvas leg) sits behind `hooks`.
import {
  carriesTutorialMarker,
  isTutorialSessionName,
  THINK,
  toTranscript,
  type CapturedQuest,
  type CoreTutorialVisibility,
  type TutorialDraftContent,
  type TutorialTurn,
} from '@bike4mind/common';
import { DRAFT_ID, type DraftCore, type DraftProfile } from './draftCore';

export interface CaptureSession {
  name?: string;
  users?: unknown[];
  groups?: unknown[];
  isGlobalWrite?: boolean;
  surface?: string | null;
  tutorial?: { owner: string; moduleId: string } | null;
}

export interface CaptureDeps {
  /** The session when `userId` owns it and it is live; null otherwise. */
  loadOwnedSession(sessionId: string, userId: string): Promise<CaptureSession | null>;
  quests(sessionId: string): Promise<(CapturedQuest & { id: string })[]>;
}

export type CaptureRefusal = { ok: false; status: number; error: string; code?: string };

export interface CaptureHooks<TCanvas> {
  /** True when this owner may capture a session on `surface`; core accepts only the main surface. */
  acceptsSurface(surface: string | undefined): boolean;
  /** Tool name prefixes of other surfaces; a quest that called one is refused as a session moved off its surface. */
  foreignToolPrefixes?: readonly string[];
  /** What a captured transcript keeps before other learners replay it. */
  scrub(turns: TutorialTurn[]): TutorialTurn[];
  /** The owner's canvas leg; absent captures without a canvas. */
  canvas?(input: {
    sessionId: string;
    transcript: TutorialTurn[];
    quests: readonly (CapturedQuest & { id: string })[];
    canvasTurn?: number;
  }): Promise<{ ok: true; canvas: TCanvas; canvasNodeId?: string } | CaptureRefusal>;
}

export interface CaptureInput {
  sessionId: string;
  moduleId: string;
  title: string;
  canvasTurn?: number;
  visibility?: CoreTutorialVisibility;
}

export type CaptureResult<TCanvas> = { ok: true; content: TutorialDraftContent<TCanvas> } | CaptureRefusal;

export const refuse = (status: number, error: string, code?: string): CaptureRefusal => ({
  ok: false,
  status,
  error,
  code,
});

const timeOf = (quest: CapturedQuest) => new Date(quest.createdAt ?? quest.timestamp ?? 0).getTime();

/** Core's default: reasoning stripped, no tool results, no UI side effects. */
export function scrubPlainTranscript(turns: readonly TutorialTurn[]): TutorialTurn[] {
  return turns.map(({ prompt, reply, attachSheet }) => ({
    prompt: prompt.replace(THINK, '').trim(),
    reply: reply.replace(THINK, '').trim(),
    ...(attachSheet && { attachSheet: true }),
  }));
}

function calledToolWithPrefix(quests: readonly CapturedQuest[], prefixes: readonly string[]): boolean {
  const hasPrefix = (name: unknown) => typeof name === 'string' && prefixes.some(prefix => name.startsWith(prefix));
  return quests.some(
    quest =>
      (quest.promptMeta?.functionCalls ?? []).some(call => hasPrefix(call?.name)) ||
      (quest.structuredReplies ?? []).some(reply =>
        (Array.isArray(reply.content) ? reply.content : []).some(
          (block: { type?: unknown; name?: unknown }) => block?.type === 'tool_use' && hasPrefix(block.name)
        )
      )
  );
}

/**
 * The admin's own finished session as a draft. A quest records no author and a collaborator can add one, so
 * only an unshared session the admin owns is taken. A session a tutorial played into is refused: its marker
 * would win the turn match for every learner.
 */
export async function captureSession<TCanvas extends { turn: number }>(
  core: DraftCore<TCanvas>,
  profile: Pick<DraftProfile<TCanvas>, 'isRepoModuleId' | 'defaultFinale' | 'starterSteps'>,
  deps: CaptureDeps,
  hooks: CaptureHooks<TCanvas>,
  userId: string,
  input: CaptureInput
): Promise<CaptureResult<TCanvas>> {
  if (!DRAFT_ID.test(input.moduleId)) return refuse(400, 'The id is lowercase letters, digits and dashes');
  if (profile.isRepoModuleId(input.moduleId)) return refuse(409, 'A repo module already has this id', 'ID_TAKEN');
  const session = await deps.loadOwnedSession(input.sessionId, userId);
  if (!session) return refuse(404, 'No such session of yours');
  const wrongSurface = "Capture a session from this owner's own chat";
  if (!hooks.acceptsSurface(session.surface ?? undefined)) return refuse(409, wrongSurface, 'SURFACE');
  if ((session.users?.length ?? 0) > 0 || (session.groups?.length ?? 0) > 0 || session.isGlobalWrite) {
    return refuse(409, 'The session is shared; capture one only you can write to', 'SESSION_SHARED');
  }
  const quests = [...(await deps.quests(input.sessionId))].sort((a, b) => timeOf(a) - timeOf(b));
  if (hooks.foreignToolPrefixes?.length && calledToolWithPrefix(quests, hooks.foreignToolPrefixes)) {
    return refuse(409, wrongSurface, 'SURFACE');
  }
  if (isTutorialSessionName(session.name) || session.tutorial || quests.some(q => carriesTutorialMarker(q))) {
    return refuse(409, 'A tutorial ran in this session; capture a session of your own', 'TUTORIAL_SESSION');
  }
  if (quests.length < 2) return refuse(422, 'The session needs at least two finished turns', 'TOO_SHORT');

  let transcript: TutorialTurn[];
  try {
    transcript = hooks.scrub(toTranscript(quests));
  } catch (error) {
    return refuse(422, `The session cannot be captured: ${(error as Error).message}`, 'UNFINISHED');
  }

  let canvas: { canvas: TCanvas; canvasNodeId?: string } | undefined;
  if (hooks.canvas) {
    const leg = await hooks.canvas({ sessionId: input.sessionId, transcript, quests, canvasTurn: input.canvasTurn });
    if (!leg.ok) return leg;
    canvas = leg;
  }

  const content: TutorialDraftContent<TCanvas> = {
    moduleId: input.moduleId,
    title: input.title.trim(),
    pitch: '',
    transcript,
    ...(canvas && { canvas: canvas.canvas }),
    steps: profile.starterSteps(transcript),
    ...(canvas?.canvasNodeId && { canvasNodeId: canvas.canvasNodeId }),
    finale: profile.defaultFinale,
    ...(input.visibility && { visibility: input.visibility }),
  };
  return { ok: true, content: { ...content, steps: core.normalizeDraftSteps(content) } };
}
