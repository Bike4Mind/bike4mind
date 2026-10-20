import type { ComponentType } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

/**
 * Registration seam for extra controls on a fenced code block in chat (a Run button, say).
 *
 * Core ships no actions; a surface registers one (typically on mount, unregistering on
 * unmount so the action stays scoped to that surface) and every chat code renderer picks it
 * up. Keep these in sync:
 * - reply fences: CodeBlockHeader up to 10 lines, CodeArtifactPreviewCard beyond that
 *   (PromptReplies createCodeComponent);
 * - prompt fences: always CodeBlockHeader (UserPrompt);
 * - code artifacts: CodeArtifactPreviewCard, whose language defaults to 'typescript'
 *   (artifacts/handlers/code.tsx).
 */

export type CodeBlockActionProps = {
  code: string;
  /** The language as written (e.g. 'py' or 'python'); 'text' for a fence that had none. */
  language: string;
  /**
   * Element under the code for the action's output; render into it with
   * CodeBlockActionOutput (components/common/CodeBlockActions.tsx). Null until it mounts.
   */
  outputSlot: HTMLElement | null;
};

export type CodeBlockAction = {
  /** Unique; a second registration with the same id replaces the first. */
  id: string;
  appliesTo: (language: string) => boolean;
  Control: ComponentType<CodeBlockActionProps>;
};

let actions: readonly CodeBlockAction[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly CodeBlockAction[]) {
  actions = next;
  listeners.forEach(listener => listener());
}

/**
 * Register an action. Returns an unregister function. One live registration per id: a
 * second registration replaces the first (whose cleanup then does nothing). Registrations
 * are not counted, so the same object registered twice is gone after the first cleanup.
 */
export function registerCodeBlockAction(action: CodeBlockAction): () => void {
  publish([...actions.filter(existing => existing.id !== action.id), action]);
  return () => {
    // Only remove this exact registration, so a stale cleanup cannot drop a replacement.
    if (actions.includes(action)) publish(actions.filter(existing => existing !== action));
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => actions;

/** The registered actions that apply to a fence in `language`, re-rendering on (un)registration. */
export function useCodeBlockActions(language: string): readonly CodeBlockAction[] {
  const registered = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => registered.filter(action => action.appliesTo(language)), [registered, language]);
}
