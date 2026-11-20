import { createContext, useContext } from 'react';
import type { TutorialStepRegistry, TutorialTransport } from './types';

export interface TutorialHostValue {
  apiBase: string;
  steps: TutorialStepRegistry;
  transport: TutorialTransport;
}

export const TutorialHostContext = createContext<TutorialHostValue | null>(null);

export function useTutorialHost(): TutorialHostValue {
  const host = useContext(TutorialHostContext);
  if (!host) throw new Error('useTutorialHost needs a TutorialHostProvider above it');
  return host;
}

/** The provider's `apiBase`, or `explicit` where there is no provider. Throws when neither names a host. */
export function useTutorialHostBase(explicit?: string): string {
  const host = useContext(TutorialHostContext);
  const apiBase = explicit ?? host?.apiBase;
  if (!apiBase) throw new Error('A tutorial hook needs a TutorialHostProvider above it, or an apiBase');
  return apiBase;
}
