import type { TutorialProgressEntry, TutorialStatus, TutorialStep } from './tutorial';

export type TutorialRunAction = 'progress' | 'modules' | 'start' | 'resume' | 'sheet' | 'advance' | 'position';

export type TutorialRunRequest =
  | { action: 'progress' }
  | { action: 'modules' }
  | { action: 'start'; moduleId: string }
  | { action: 'resume'; moduleId: string }
  | { action: 'sheet'; moduleId: string }
  | { action: 'advance'; moduleId: string; sessionId: string; turn: number }
  | {
      action: 'position';
      moduleId: string;
      stepId: string;
      status: TutorialStatus;
      version?: number;
      revision?: number;
    };

/** A module as the page runs it: client fields only, overrides applied. */
export interface TutorialRunModule {
  id: string;
  title: string;
  pitch: string;
  version: number;
  revision: number;
  enabled: boolean;
  steps: readonly TutorialStep[];
  canvasSolve?: { nodeId: string; turn: number };
  created?: boolean;
}

/** A recorded quest the advance action inserted. */
export interface TutorialRunQuest {
  id?: string;
  sessionId: string;
  timestamp: string;
  type: 'message';
  prompt: string;
  reply: string;
  replies: string[];
  status: 'done';
  fabFileIds?: string[];
  toolResults?: { tool_use_id: string; content: string; is_error?: boolean }[];
  uiSideEffects: { type: string; payload: unknown }[];
  promptMeta: { session: { id: string; userId: string } };
}

/** One module's saved position as the server stores it, dates serialized. */
export interface TutorialRunProgressEntry extends TutorialProgressEntry {
  turn: number;
  turnClaimedAt: string;
  updatedAt: string;
}

export interface TutorialRunProgressResponse {
  modules: Record<string, TutorialRunProgressEntry>;
}
export interface TutorialRunModulesResponse {
  modules: TutorialRunModule[];
}
export interface TutorialRunStartResponse {
  sessionId: string;
  turn: -1;
  version: number;
  revision: number;
}
export interface TutorialRunResumeResponse {
  sessionId: string;
  version: number;
  revision: number;
}
export interface TutorialRunSheetResponse {
  fileId: string;
}
export interface TutorialRunAdvanceResponse {
  quest: TutorialRunQuest;
  turn: number;
}
export interface TutorialRunPositionResponse {
  moduleId: string;
}

export interface TutorialRunResponseByAction {
  progress: TutorialRunProgressResponse;
  modules: TutorialRunModulesResponse;
  start: TutorialRunStartResponse;
  resume: TutorialRunResumeResponse;
  sheet: TutorialRunSheetResponse;
  advance: TutorialRunAdvanceResponse;
  position: TutorialRunPositionResponse;
}

export interface TutorialRunError {
  error: string;
  code?: string;
}
