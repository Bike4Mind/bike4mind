import { create, useStore, type StoreApi, type UseBoundStore } from 'zustand';
import { useTutorialHostBase } from './hostBase';

export interface ActiveTutorial {
  moduleId: string;
  sessionId: string;
  stepId: string;
  /** As start or resume returned them, so a position report names the module the walk runs. */
  version?: number;
  revision?: number;
}

/** A module whose opening message waits in the host's own start box for the user to send it. */
export interface PendingTutorial {
  moduleId: string;
  prompt: string;
}

export interface TutorialJump {
  moduleId: string;
  stepId: string;
}

export interface TutorialState {
  active: ActiveTutorial | null;
  pending: PendingTutorial | null;
  /** A step picked from the journey panel, taken up by the module's runner once that module is active. */
  pendingJump: TutorialJump | null;
  journeyOpen: boolean;
  begin: (active: ActiveTutorial) => void;
  setPending: (pending: PendingTutorial | null) => void;
  goTo: (stepId: string) => void;
  end: () => void;
  requestJump: (jump: TutorialJump) => void;
  clearJump: () => void;
  setJourneyOpen: (open: boolean) => void;
}

export type TutorialStore = UseBoundStore<StoreApi<TutorialState>>;

export const createTutorialStore = (): TutorialStore =>
  create<TutorialState>(set => ({
    active: null,
    pending: null,
    pendingJump: null,
    journeyOpen: false,
    begin: active => set({ active, pending: null }),
    setPending: pending => set(pending ? { pending, active: null } : { pending }),
    goTo: stepId => set(state => (state.active ? { active: { ...state.active, stepId } } : state)),
    end: () => set({ active: null, pendingJump: null }),
    requestJump: pendingJump => set({ pendingJump, journeyOpen: false }),
    clearJump: () => set({ pendingJump: null }),
    setJourneyOpen: journeyOpen => set({ journeyOpen }),
  }));

const stores = new Map<string, TutorialStore>();

/** One store per host, so a walk on one API base never shows as active on another. */
export function tutorialStoreFor(apiBase: string): TutorialStore {
  let store = stores.get(apiBase);
  if (!store) {
    store = createTutorialStore();
    stores.set(apiBase, store);
  }
  return store;
}

/** Drops every host's store, for tests that start from a clean slate. */
export const resetTutorialStores = () => stores.clear();

/** The calling host's store: the provider's `apiBase`, or the one passed for a surface outside a provider. */
export function useTutorialStoreApi(apiBase?: string): TutorialStore {
  return tutorialStoreFor(useTutorialHostBase(apiBase));
}

export function useTutorialStore<T>(selector: (state: TutorialState) => T, apiBase?: string): T {
  return useStore(useTutorialStoreApi(apiBase), selector);
}
