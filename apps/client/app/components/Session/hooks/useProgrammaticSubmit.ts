import { useCallback, useEffect, useRef } from 'react';

import type { B4MLLMTools, IChatHistoryItemDocument, ISessionDocument } from '@bike4mind/common';
import { ReadyState } from '@client/app/contexts/WebsocketContext';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { isFreshNonce } from '@client/app/utils/briefcase/dispatchDedup';

interface UseProgrammaticSubmitParams {
  /** The send function to drive - typically `useSendMessage`'s `handleSendClick`. */
  handleSendClick: (
    prompt?: string,
    options?: { forceEnableQuestMaster?: boolean; toolsOverride?: B4MLLMTools[] }
  ) => Promise<IChatHistoryItemDocument | undefined>;
  readyState: ReadyState;
  submitting: boolean;
  currentSession: ISessionDocument | null;
}

/**
 * Drives external/programmatic sends for the SessionBottom, extracted from
 * `useSendMessage`. Two `useChatInput` channels feed it:
 *  - `programmaticSubmit`: a bare prompt string set by callers like the opti
 *    consoles' "Draft a problem with AI".
 *  - `programmaticLaunch`: a briefcase one-click dispatch carrying prompt content,
 *    required tools, an optional target `sessionId`, and a dedup nonce.
 *
 * Uses `useChatInput.subscribe()` rather than a hook+useEffect read so the trigger
 * is reliable even when SessionBottom is lazy-loaded inside Suspense.
 *
 * IMPORTANT: every consumer path gates on `currentSession` being non-null. On `/opti`,
 * `createNewSession` sets `programmaticSubmit` before `changeSession` completes, so
 * `currentSession` is still null. Without this guard a `sessionId: undefined` reaches
 * the server, which mints a NEW session and lands the response on the wrong notebook.
 * The retry effect picks the prompt up once `changeSession` finishes.
 */
export function useProgrammaticSubmit({
  handleSendClick,
  readyState,
  submitting,
  currentSession,
}: UseProgrammaticSubmitParams): void {
  const readyStateRef = useRef(readyState);
  // eslint-disable-next-line react-hooks/refs
  readyStateRef.current = readyState;

  const submittingRef = useRef(submitting);
  // eslint-disable-next-line react-hooks/refs
  submittingRef.current = submitting;

  const handleSendClickRef = useRef(handleSendClick);
  // eslint-disable-next-line react-hooks/refs
  handleSendClickRef.current = handleSendClick;

  const currentSessionRef = useRef(currentSession);
  // eslint-disable-next-line react-hooks/refs
  currentSessionRef.current = currentSession;

  // Consume a pending briefcase launch if this surface is the elected target and
  // ready. Session election: a dispatch carrying a sessionId is only handled by
  // the matching surface; a null sessionId may be handled by any (the nonce guard
  // ensures exactly-once even if two subscribers match).
  // Pending launch send-timers, cleared on unmount so a fast route/session switch
  // can't fire a send into a stale session after the component is gone.
  const launchTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const tryConsumeLaunch = useCallback(() => {
    const dispatch = useChatInput.getState().programmaticLaunch;
    if (!dispatch) return;
    if (readyStateRef.current !== ReadyState.OPEN || submittingRef.current || !currentSessionRef.current) return;
    if (dispatch.sessionId && dispatch.sessionId !== currentSessionRef.current.id) return;
    // De-dupe across subscribers/re-mounts before doing anything observable.
    if (!isFreshNonce(dispatch.dispatchNonce)) {
      useChatInput.getState().setProgrammaticLaunch(null);
      return;
    }
    useChatInput.getState().setProgrammaticLaunch(null);
    const toolsOverride = dispatch.requiredTools ?? undefined;
    const content = dispatch.promptContent;
    // The elected session at consume time - the send is dropped if it changes
    // during the settle delay (election must hold through to the actual send).
    const electedSessionId = currentSessionRef.current.id;
    const timer = setTimeout(() => {
      launchTimersRef.current.delete(timer);
      if (currentSessionRef.current?.id !== electedSessionId) return;
      handleSendClickRef.current(content, { toolsOverride });
    }, 150);
    launchTimersRef.current.add(timer);
  }, []);

  useEffect(() => {
    const initial = useChatInput.getState().programmaticSubmit;
    if (initial && readyStateRef.current === ReadyState.OPEN && !submittingRef.current && currentSessionRef.current) {
      useChatInput.getState().setProgrammaticSubmit(null);
      setTimeout(() => handleSendClickRef.current(initial), 150);
    }
    tryConsumeLaunch();

    const unsub = useChatInput.subscribe((state, prevState) => {
      const prompt = state.programmaticSubmit;
      if (prompt && prompt !== prevState.programmaticSubmit) {
        if (readyStateRef.current === ReadyState.OPEN && !submittingRef.current && currentSessionRef.current) {
          useChatInput.getState().setProgrammaticSubmit(null);
          setTimeout(() => handleSendClickRef.current(prompt), 150);
        }
      }

      if (state.programmaticLaunch && state.programmaticLaunch !== prevState.programmaticLaunch) {
        tryConsumeLaunch();
      }
    });

    const timers = launchTimersRef.current;
    return () => {
      unsub();
      timers.forEach(clearTimeout);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retry sending if readyState, submitting, or currentSession changes while a prompt is pending.
  // The currentSession dep is critical: on /opti, programmaticSubmit is set before changeSession
  // completes. Once changeSession sets currentSession, this effect fires and sends the prompt.
  useEffect(() => {
    const prompt = useChatInput.getState().programmaticSubmit;
    if (prompt && readyState === ReadyState.OPEN && !submitting && currentSession) {
      useChatInput.getState().setProgrammaticSubmit(null);
      setTimeout(() => handleSendClick(prompt), 150);
    }
    tryConsumeLaunch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyState, submitting, currentSession]);
}
