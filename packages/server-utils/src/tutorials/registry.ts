import type { CoreTutorialVisibility, TutorialTrack } from '@bike4mind/common';

export interface CoreTutorial {
  id: string;
  title: string;
  visibility: CoreTutorialVisibility;
  enabled: boolean;
  /** The picker group the core host lists it under. Optional so a generated entry (tutorials:apply) still compiles. */
  track?: TutorialTrack;
}

// Server-only: the client must never import this file (see registry.clientImports.repo.test.ts).
export const CORE_TUTORIALS: readonly CoreTutorial[] = [
  { id: 'first-steps', title: 'First steps', visibility: { public: true }, enabled: true, track: 'basics' },
];

/** Resolves only core's own tutorials, so an owner's module id never reaches a core route. */
export function resolveCoreTutorial(id: string): CoreTutorial | null {
  return CORE_TUTORIALS.find(t => t.id === id) ?? null;
}
