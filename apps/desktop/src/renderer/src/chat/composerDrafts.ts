import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { isKeptDraft, type ComposerDrafts } from '@shared/composerDrafts';
import type { DesktopApi } from '@shared/ipc';

type DraftsBridge = DesktopApi['composerDrafts'];

type DraftsState = {
  drafts: ComposerDrafts;
  /** False until main's saved drafts have been read in. */
  hydrated: boolean;
};

export type ComposerDraftsStore = {
  state: StoreApi<DraftsState>;
  /** Reads main's saved drafts in. A draft already typed here since launch wins over the saved one. */
  hydrate(): Promise<void>;
  /** Records a conversation's text and sends it to main at once; main batches the disk writes. */
  update(sessionId: string, text: string): void;
};

/**
 * The renderer's copy of the unsent composer text (see @shared/composerDrafts). Held here rather
 * than in Composer so the sidebar can mark conversations with a draft. `bridge` is read per call,
 * so a test or a missing preload just keeps drafts in memory.
 *
 * Every change goes to main undelayed: a debounce here would be lost on a quit, because nothing in
 * the renderer runs reliably before main's `will-quit` flush.
 */
export function createComposerDraftsStore(bridge: () => DraftsBridge | undefined): ComposerDraftsStore {
  const state = createStore<DraftsState>(() => ({ drafts: {}, hydrated: false }));
  // Ids changed since launch, so hydrating cannot bring back text the user has since replaced.
  const touched = new Set<string>();

  const save = (sessionId: string) => {
    const api = bridge();
    if (!api) return;
    Promise.resolve(api.save(sessionId, state.getState().drafts[sessionId] ?? '')).catch((error: unknown) => {
      console.warn(`DRAFTS: could not save the composer draft: ${String(error)}`);
    });
  };

  return {
    state,
    async hydrate() {
      const api = bridge();
      if (!api) {
        state.setState({ hydrated: true });
        return;
      }
      try {
        const saved: unknown = await api.list();
        const local = state.getState().drafts;
        const merged: ComposerDrafts = {};
        if (typeof saved === 'object' && saved !== null && !Array.isArray(saved)) {
          for (const [sessionId, text] of Object.entries(saved)) if (typeof text === 'string') merged[sessionId] = text;
        }
        for (const sessionId of touched) {
          if (local[sessionId] === undefined) delete merged[sessionId];
          else merged[sessionId] = local[sessionId];
        }
        state.setState({ drafts: merged, hydrated: true });
      } catch (error) {
        console.warn(`DRAFTS: could not read saved composer drafts: ${String(error)}`);
        state.setState({ hydrated: true });
      }
    },
    update(sessionId, text) {
      const kept = isKeptDraft(text) ? text : undefined;
      const { drafts } = state.getState();
      if (drafts[sessionId] === kept) return;
      touched.add(sessionId);
      const next = { ...drafts };
      if (kept === undefined) delete next[sessionId];
      else next[sessionId] = kept;
      state.setState({ drafts: next });
      // A not-yet-created conversation (see isSessionDraft in useSessionDraft) is unknown to main, which would drop it.
      if (!sessionId.startsWith('draft-')) save(sessionId);
    },
  };
}

const bridge = (): DraftsBridge | undefined =>
  typeof window === 'undefined' ? undefined : (window.b4m as Partial<DesktopApi> | undefined)?.composerDrafts;

export const composerDrafts = createComposerDraftsStore(bridge);

if (typeof window !== 'undefined') void composerDrafts.hydrate();

/** Whether a conversation has unsent text, for the sidebar's marker. */
export function useHasComposerDraft(sessionId: string): boolean {
  return useStore(composerDrafts.state, state => state.drafts[sessionId] !== undefined);
}

/** True once saved drafts have been read in, so Composer can restore one that arrived late. */
export function useComposerDraftsHydrated(): boolean {
  return useStore(composerDrafts.state, state => state.hydrated);
}
