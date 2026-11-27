import type { CoreTutorialVisibility, TutorialTrack } from '@bike4mind/common';

export interface CoreTutorial {
  id: string;
  title: string;
  visibility: CoreTutorialVisibility;
  enabled: boolean;
  /** The picker group the core host lists it under. Optional so a generated entry (tutorials:apply) still compiles. */
  track?: TutorialTrack;
  /** Position in the picker, lowest first; entries without one follow in registry order. */
  order?: number;
}

// Server-only: the client must never import this file (see registry.clientImports.repo.test.ts).
export const CORE_TUTORIALS: readonly CoreTutorial[] = [
  { id: 'first-steps', title: 'First steps', visibility: { public: true }, enabled: true, track: 'basics', order: 10 },
  {
    id: 'switching-models',
    title: 'Switch models mid-conversation',
    visibility: { public: true },
    enabled: true,
    track: 'different',
    order: 20,
  },
  {
    id: 'grounded-answers',
    title: 'Answers from your files',
    visibility: { public: true },
    enabled: true,
    track: 'different',
    order: 30,
  },
  {
    id: 'artifacts',
    title: 'Make a page you can keep',
    visibility: { public: true },
    enabled: true,
    track: 'different',
    order: 40,
  },
  {
    id: 'projects',
    title: 'Work in a project',
    visibility: { public: true },
    enabled: true,
    track: 'different',
    order: 50,
  },
  {
    id: 'import-history',
    title: 'Bring your chat history',
    visibility: { public: true },
    enabled: true,
    track: 'different',
    order: 60,
  },
];

/** Resolves only core's own tutorials, so an owner's module id never reaches a core route. */
export function resolveCoreTutorial(id: string): CoreTutorial | null {
  return CORE_TUTORIALS.find(t => t.id === id) ?? null;
}

/** Orders tutorials as the picker lists them: by `order`, then by place in the registry, unknown ids last. */
export function compareByCatalogue(registry: readonly Pick<CoreTutorial, 'id' | 'order'>[]) {
  const rank = (id: string): [number, number] => {
    const index = registry.findIndex(t => t.id === id);
    if (index === -1) return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    return [registry[index].order ?? Number.POSITIVE_INFINITY, index];
  };
  return (a: { id: string }, b: { id: string }): number => {
    const [orderA, indexA] = rank(a.id);
    const [orderB, indexB] = rank(b.id);
    if (orderA !== orderB) return orderA < orderB ? -1 : 1;
    if (indexA !== indexB) return indexA < indexB ? -1 : 1;
    return 0;
  };
}

export const byCoreTutorialRank = compareByCatalogue(CORE_TUTORIALS);
