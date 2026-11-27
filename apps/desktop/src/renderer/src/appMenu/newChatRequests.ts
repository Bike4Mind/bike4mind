import { useEffect, useRef } from 'react';

/**
 * How long a New Chat request waits for a chat view to take it. The menu can be used from
 * Settings, which first navigates home; a request no chat view picks up within this (signed out,
 * say) is dropped rather than firing on some later, unrelated mount.
 */
export const NEW_CHAT_REQUEST_TTL_MS = 5_000;

let pendingSince: number | null = null;
const listeners = new Set<() => void>();

/** The app menu's New Chat; ChatShell carries it out through useNewChatRequests. */
export function requestNewChat(now: number = Date.now()): void {
  pendingSince = now;
  for (const listener of listeners) listener();
}

/** Consume the pending request; true only if there was one still fresh enough to act on. */
export function takeNewChatRequest(now: number = Date.now()): boolean {
  const fresh = pendingSince !== null && now - pendingSince <= NEW_CHAT_REQUEST_TTL_MS;
  pendingSince = null;
  return fresh;
}

function onNewChatRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Run `startNewChat` for each New Chat request, including one made just before this mounted.
 * Requests wait while `ready` is false: a chat view that has not yet restored its last
 * conversation would otherwise select it right over the new chat.
 */
export function useNewChatRequests(startNewChat: () => void, ready: boolean): void {
  const latest = useRef(startNewChat);
  useEffect(() => {
    latest.current = startNewChat;
  }, [startNewChat]);
  useEffect(() => {
    if (!ready) return;
    const handle = () => {
      if (takeNewChatRequest()) latest.current();
    };
    handle();
    return onNewChatRequest(handle);
  }, [ready]);
}
