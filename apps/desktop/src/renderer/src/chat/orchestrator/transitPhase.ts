import type { AgentState } from '@shared/agentState';

/** The stops of the Transit line, in travel order. */
export const TRANSIT_STOPS = ['waiting', 'planning', 'working', 'reviewing', 'done'] as const;
export type TransitStop = (typeof TRANSIT_STOPS)[number];

/** Where an agent sits: a stop on the line, or off it when the run ended without finishing. */
export type TransitPhase = TransitStop | 'off-line';

export const TRANSIT_STOP_LABEL: Record<TransitStop, string> = {
  waiting: 'Waiting',
  planning: 'Planning',
  working: 'Working',
  reviewing: 'Reviewing',
  done: 'Done',
};

// Checked in this order: "Bash pnpm test" is verification, not plain work.
const REVIEWING = /\b(test|tests|vitest|jest|lint|typecheck|tsc|review|verify|verifying|diff|check|checking)\b/i;
const PLANNING = /^(thinking|planning|plan|research|researching|todo|todowrite)\b|\bplan\b/i;
const WORKING =
  /^(edit|multiedit|write|notebookedit|patch|apply|bash|shell|exec|run|read|grep|glob|ls|list|find|search|fetch|web|task|session_|preparing|writing a reply)/i;

/**
 * The stop an agent belongs at, from its state and the one-line activity the snapshot carries (the
 * only signal a view has). Only a working agent is read from its text; a working agent whose text is
 * missing or not recognised stays at Waiting rather than guessing a phase.
 */
export function transitPhase(state: AgentState, activity?: string): TransitPhase {
  switch (state) {
    case 'done':
      return 'done';
    case 'failed':
    case 'stopped':
      return 'off-line';
    case 'needs-you':
    case 'idle':
      return 'waiting';
    case 'working': {
      const text = activity?.trim() ?? '';
      if (REVIEWING.test(text)) return 'reviewing';
      if (PLANNING.test(text)) return 'planning';
      if (WORKING.test(text)) return 'working';
      return 'waiting';
    }
  }
}
