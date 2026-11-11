import type { TutorialStep } from '@bike4mind/common';

export interface TutorialModuleIntro {
  id: string;
  title: string;
  pitch: string;
  openingPrompt: string;
  /** `retired` lists names this sheet shipped under before, whose tagged copies are removed. */
  sheet?: { name: string; csv: string; retired?: readonly string[] };
}

export interface TutorialTurn {
  prompt: string;
  reply: string;
  uiSideEffects?: { type: string; payload: unknown }[];
  toolResults?: { tool_use_id: string; content: string; is_error?: boolean }[];
  /** The turn on which the user's own copy of the sheet rides as the quest's attachment. */
  attachSheet?: boolean;
}

/** A recorded canvas, seeded when `turn` lands. The document is the owner's shape, opaque here. */
export interface TutorialCanvas {
  turn: number;
  label: string;
  addedIds: string[];
  doc: unknown;
}

/** A module as the server plays it: the intro plus the recorded quests. Turn 0 is the opening quest. */
export interface TutorialModule extends TutorialModuleIntro {
  /**
   * Bump when an edit would misplace or invalidate a saved step id, or changes the transcript so a saved
   * position no longer replays correctly, so it falls back to the start.
   */
  version: number;
  /** Moved only by a runtime override that changes structure, so a running walk restarts. 0 without one. */
  revision: number;
  enabled: boolean;
  /** Stable ids, never indexes, so editing a module does not misplace a saved position. */
  steps: TutorialStep[];
  transcript: TutorialTurn[];
  canvas?: TutorialCanvas;
  /** Passed through to the page untouched. */
  canvasSolve?: { nodeId: string; turn: number };
  /** Made by an admin rather than shipped in code. */
  created?: boolean;
}

/** A module as the repo ships it: the steps before any closing steps, and the recorded turns. */
export interface RepoTutorial {
  intro: TutorialModuleIntro;
  version: number;
  enabled: boolean;
  steps: readonly TutorialStep[];
  transcript: readonly TutorialTurn[];
  canvas?: TutorialCanvas;
  canvasSolve?: { nodeId: string; turn: number };
}
