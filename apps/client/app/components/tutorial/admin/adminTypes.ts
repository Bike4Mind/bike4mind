import type { OverrideUnit, TutorialStep, UnitState, ValidationIssue } from '@bike4mind/common';

/** What an admin's modules request returns for one module: its switch, its edits, and the content they are written against. */
export interface TutorialModuleOverrideRow {
  moduleId: string;
  title: string;
  version: number;
  revision: number;
  /** Moves on every write; the editor sends back the value its draft started from. Null before any write. */
  contentSeq: number | null;
  repoEnabled: boolean;
  enabled: boolean;
  overridden: boolean;
  lastChange: { field: string; actorId: string; reason: string; at: string } | null;
  /** The latest change to the edits themselves, so a later switch toggle does not claim their authorship. */
  lastFieldsChange: { actorId: string; reason: string; at: string } | null;
  repo: {
    steps: TutorialStep[];
    turns: { turn: number; prompt: string; reply: string }[];
  };
  /** Per step id, the copy fields an edit may change; prompts appear under the step that sends them. */
  editable: Record<string, string[]>;
  fields: OverrideUnit[];
  report: {
    states: { key: string; state: UnitState }[];
    /** Why the module's overrides were refused, so it serves the repo content; empty when they apply. */
    rejected: ValidationIssue[];
    structuralDigest: string;
  };
}

export interface TutorialAnchorChoices {
  anchors: string[];
  anchorScopes: string[];
  avoids: string[];
}

export interface TutorialModulesResponse {
  modules: TutorialModuleOverrideRow[];
  choices: TutorialAnchorChoices;
}
