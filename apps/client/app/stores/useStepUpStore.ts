import { create } from 'zustand';

type StepUpState = {
  open: boolean;
  /** Shared by every request that hits a step-up requirement while the prompt is open. */
  pending: Promise<void> | null;
  resolvePending: (() => void) | null;
  rejectPending: ((reason: Error) => void) | null;
  /** Opens the prompt (or joins the one already open). Resolves once the user verifies. */
  requestStepUp: () => Promise<void>;
  completeStepUp: () => void;
  cancelStepUp: () => void;
};

export const STEP_UP_CANCELLED_MESSAGE = 'Step-up verification cancelled';

export const useStepUpStore = create<StepUpState>((set, get) => ({
  open: false,
  pending: null,
  resolvePending: null,
  rejectPending: null,
  requestStepUp: () => {
    const existing = get().pending;
    if (existing) return existing;
    const pending = new Promise<void>((resolve, reject) => {
      set({ open: true, resolvePending: resolve, rejectPending: reject });
    });
    set({ pending });
    return pending;
  },
  completeStepUp: () => {
    get().resolvePending?.();
    set({ open: false, pending: null, resolvePending: null, rejectPending: null });
  },
  cancelStepUp: () => {
    get().rejectPending?.(new Error(STEP_UP_CANCELLED_MESSAGE));
    set({ open: false, pending: null, resolvePending: null, rejectPending: null });
  },
}));
