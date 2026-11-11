import type { ComponentType } from 'react';
import type { TutorialCardSide, TutorialProgressEntry, TutorialStatus, TutorialStep } from '@bike4mind/common';

export interface TutorialScript {
  id: string;
  steps: readonly TutorialStep[];
}

/** The fields of a session quest the engine reads. */
export interface TutorialQuest {
  id: string;
  prompt?: string;
  status?: string;
  uiSideEffects?: readonly ({ type?: string; payload?: unknown } | null | undefined)[] | null;
  _optimistic?: boolean;
}

/** The module's identity as the server ran it; a position under any other is refused, so the page can stop. */
export interface TutorialModuleIdentity {
  version: number;
  revision: number;
}

export interface TutorialTransport {
  progress(): Promise<Record<string, TutorialProgressEntry>>;
  /** Opens a fresh session for the module, empty until the user sends its opening message. */
  start(input: { moduleId: string }): Promise<{ sessionId: string } & Partial<TutorialModuleIdentity>>;
  /** Runs the module again in the session it already has. Rejects with a 404 or 409 when that session cannot take it. */
  resume(input: { moduleId: string }): Promise<{ sessionId: string } & Partial<TutorialModuleIdentity>>;
  /** The id of the module's sheet in the user's files, created if it is missing. */
  sheet(input: { moduleId: string }): Promise<{ fileId: string }>;
  advance(input: { moduleId: string; sessionId: string; turn: number }): Promise<{ quest: TutorialQuest }>;
  /** Rejects with a 409 once the module changed under a running walk, and a 410 once it was switched off. */
  position(
    input: { moduleId: string; stepId: string; status: TutorialStatus } & Partial<TutorialModuleIdentity>
  ): Promise<void>;
}

export interface TutorialAnchorOptions {
  placement?: TutorialCardSide;
  scope?: string;
  /** A CSS selector for what the card keeps clear of at this stage, in place of the step's own. */
  avoid?: string;
}

export interface TutorialStepProps {
  step: TutorialStep;
  sessionId: string;
  /** The session's quests, newest first, for steps that act on what a seeded turn carried. */
  quests: readonly TutorialQuest[];
  /** Moves to the next step, or finishes the module after the last. */
  complete: () => void;
  /** Seeds the recorded turn into the session and puts it in the chat's quest list. */
  advance: (turn: number) => Promise<void>;
  /** Starts another module from the beginning; absent when the host offers no way to. */
  startModule?: (moduleId: string) => void;
  /** Takes the user to where they start work of their own; absent when the host has nowhere to send them. */
  exit?: () => void;
  /**
   * Points the card at another control than the step's own anchor, for a step that walks several.
   * Undefined restores the step's anchor; an empty string docks the card with nothing ringed. Each stage can
   * pick its own side, scope and avoid; one it leaves out falls back to the step's. An explicit `scope: undefined`
   * searches the whole page, for a stage whose control sits outside the step's scope (in a modal, say).
   */
  setAnchor: (testid: string | undefined, options?: TutorialAnchorOptions) => void;
  /** The anchor and scope the card is watching now, after any `setAnchor` override. */
  anchor?: string;
  anchorScope?: string;
  /** Switches the card to the step's `doneBody` while its action is done and it waits for Next; `false` switches back. */
  markDone?: (done?: boolean) => void;
  /** The module's sheet in the user's files, for a step that has them attach it. */
  sheetFileId: () => Promise<string>;
}

/** Step renderers by `TutorialStep.type`. The host merges its own types over the generic ones. */
export type TutorialStepRegistry = Readonly<Record<string, ComponentType<TutorialStepProps>>>;
