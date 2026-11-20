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
  /** Records a conversation's text. Saving waits for a pause in typing; clearing is immediate. */
  update(sessionId: string, text: string): void;
  /** Saves now whatever is waiting on the debounce: on blur, on a session switch, on unload. */
  flush(sessionId?: string): void;
};

/** Typing pause before a draft is written (ms). A crash loses at most this much. */
export const DRAFT_SAVE_DEBOUNCE_MS = 500;

/**
 * The renderer's copy of the unsent composer text (see @shared/composerDrafts). Held here rather
 * than in Composer so the sidebar can mark conversations with a draft. `bridge` is read per call,
 * so a test or a missing preload just keeps drafts in memory.
 */
export function createComposerDraftsStore(
  bridge: () => DraftsBridge | undefined,
  debounceMs: number = DRAFT_SAVE_DEBOUNCE_MS
): ComposerDraftsStore {
  const state = createStore<DraftsState>(() => ({ drafts: {}, hydrated: false }));
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  // Ids changed since launch, so hydrating cannot bring back text the user has since replaced.
  const touched = new Set<string>();

  const save = (sessionId: string) => {
    const api = bridge();
    if (!api) return;
    Promise.resolve(api.save(sessionId, state.getState().drafts[sessionId] ?? '')).catch((error: unknown) => {
      console.warn(`DRAFTS: could not save the composer draft: ${String(error)}`);
    });
  };

  const flushOne = (sessionId: string) => {
    const timer = pending.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    pending.delete(sessionId);
    save(sessionId);
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

      const timer = pending.get(sessionId);
      if (timer !== undefined) clearTimeout(timer);
      if (kept === undefined) {
        pending.delete(sessionId);
        save(sessionId);
        return;
      }
      pending.set(
        sessionId,
        setTimeout(() => {
          pending.delete(sessionId);
          save(sessionId);
        }, debounceMs)
      );
    },
    flush(sessionId) {
      if (sessionId !== undefined) flushOne(sessionId);
      else for (const id of [...pending.keys()]) flushOne(id);
    },
  };
}

const bridge = (): DraftsBridge | undefined =>
  typeof window === 'undefined' ? undefined : (window.b4m as Partial<DesktopApi> | undefined)?.composerDrafts;

export const composerDrafts = createComposerDraftsStore(bridge);

if (typeof window !== 'undefined') {
  // A reload, a window close and a quit all unload the page; the invoke is sent before it goes.
  window.addEventListener('beforeunload', () => composerDrafts.flush());
  void composerDrafts.hydrate();
}

/** Whether a conversation has unsent text, for the sidebar's marker. */
export function useHasComposerDraft(sessionId: string): boolean {
  return useStore(composerDrafts.state, state => state.drafts[sessionId] !== undefined);
}

/** True once saved drafts have been read in, so Composer can restore one that arrived late. */
export function useComposerDraftsHydrated(): boolean {
  return useStore(composerDrafts.state, state => state.hydrated);
}
