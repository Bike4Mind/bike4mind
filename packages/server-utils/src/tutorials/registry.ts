import type { CoreTutorialVisibility } from '@bike4mind/common';

export interface CoreTutorial {
  id: string;
  title: string;
  visibility: CoreTutorialVisibility;
  enabled: boolean;
}

// Server-only: the client must never import this file (see registry.clientImports.test.ts).
export const CORE_TUTORIALS: readonly CoreTutorial[] = [];

/** Resolves only core's own tutorials, so an owner's module id never reaches a core route. */
export function resolveCoreTutorial(id: string): CoreTutorial | null {
  return CORE_TUTORIALS.find(t => t.id === id) ?? null;
}
