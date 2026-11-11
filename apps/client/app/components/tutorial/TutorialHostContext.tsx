import { useMemo, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GENERIC_TUTORIAL_STEPS } from './genericSteps';
import { TutorialHostContext, type TutorialHostValue } from './hostBase';
import { trackedTransport } from './progressCache';
import { createTutorialTransport } from './transport';
import type { TutorialStepRegistry } from './types';

export { useTutorialHost, useTutorialHostBase } from './hostBase';

/** Core's own tutorials live under this base; a premium host passes its own. */
export const CORE_TUTORIALS_API_BASE = '/api/tutorials';

const registrations = new Map<string, TutorialStepRegistry>();

/** Adds a host's step renderers to every provider on `apiBase`. Later registrations win over earlier ones. */
export function registerTutorialSteps(apiBase: string, steps: TutorialStepRegistry): void {
  registrations.set(apiBase, { ...registrations.get(apiBase), ...steps });
}

/** Drops a host's registrations, for tests. */
export const resetTutorialStepRegistrations = () => registrations.clear();

/** The generic steps, then what the host registered, then `extra`. A type none of them name falls back to StepFallback. */
export const resolveTutorialSteps = (apiBase: string, extra?: TutorialStepRegistry): TutorialStepRegistry => ({
  ...GENERIC_TUTORIAL_STEPS,
  ...registrations.get(apiBase),
  ...extra,
});

interface ProviderProps {
  apiBase: string;
  /** Renderers for this host's own step types, on top of the generic ones and any registered. */
  steps?: TutorialStepRegistry;
  children: ReactNode;
}

export function TutorialHostProvider({ apiBase, steps, children }: ProviderProps) {
  const queryClient = useQueryClient();
  const value = useMemo<TutorialHostValue>(
    () => ({
      apiBase,
      steps: resolveTutorialSteps(apiBase, steps),
      transport: trackedTransport(queryClient, createTutorialTransport(apiBase), apiBase),
    }),
    [apiBase, steps, queryClient]
  );
  return <TutorialHostContext.Provider value={value}>{children}</TutorialHostContext.Provider>;
}
