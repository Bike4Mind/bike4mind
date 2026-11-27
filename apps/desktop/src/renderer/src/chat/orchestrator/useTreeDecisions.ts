import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatHeldRelay, ChatMessage } from '@shared/chat';
import { pendingDecisionsOf, type PendingDecision } from '@shared/pendingDecisions';
import { hostChat } from '../../host/hostChat';
import { useSessionsEvents } from '../../host/useSessionEvents';
import { refreshKeyOf } from './AgentPeekDrawer';
import type { AgentState, AgentView } from './roster';

/** The states a decision can sit behind; the transcript of any other agent is never read. */
const WAITING_STATES: ReadonlySet<AgentState> = new Set(['needs-you', 'failed', 'stopped']);

/** One agent's transcript and held list, with the refreshKeyOf it was read under. */
type LoadedSource = { key: string; messages: readonly ChatMessage[]; held: readonly ChatHeldRelay[] };
type Waiting = ReadonlyArray<readonly [id: string, key: string]>;

export interface TreeDecisions {
  /** Each agent with something open, in roster order. */
  byId: ReadonlyMap<string, PendingDecision[]>;
  loadError: string | null;
  /** Read again now, after a resolve that may have left nothing to refetch on. */
  refresh(): void;
}

async function loadSource(id: string, key: string): Promise<LoadedSource> {
  const [session, held] = await Promise.all([hostChat.getSession(id, false), window.b4m.chat.getHeldRelays(id)]);
  return { key, messages: session?.messages ?? [], held };
}

function parseWaiting(serialized: string): Waiting {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown) =>
    Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
      ? [[entry[0], entry[1]] as const]
      : []
  );
}

/**
 * Every pending decision across the roster's agents. A task question comes from the roster alone;
 * approvals, held relays and the last turn need the agent's transcript and held list, which are
 * read only for agents in a waiting state and again whenever one of them changes.
 */
export function useTreeDecisions(agents: readonly AgentView[], enabled = true): TreeDecisions {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedSource>>(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  // Serialized so the effects below re-run on what was read changing, not on every roster object.
  const waitingKey = JSON.stringify(
    agents
      .filter(agent => !agent.redacted && WAITING_STATES.has(agent.state))
      .map(agent => [agent.id, refreshKeyOf(agent)])
  );
  const waiting = useMemo(() => parseWaiting(waitingKey), [waitingKey]);
  const currentKeys = useRef(new Map<string, string>());
  currentKeys.current = new Map(waiting);

  useEffect(() => {
    if (!enabled || waiting.length === 0) {
      setLoaded(new Map());
      setErrors(new Map());
      return;
    }
    let stale = false;
    const load = async () => {
      const results = await Promise.allSettled(waiting.map(([id, key]) => loadSource(id, key)));
      if (stale) return;
      const nextLoaded = new Map<string, LoadedSource>();
      const nextErrors = new Map<string, string>();
      results.forEach((result, index) => {
        const id = waiting[index][0];
        if (result.status === 'fulfilled') nextLoaded.set(id, result.value);
        else nextErrors.set(id, errorText(result.reason));
      });
      setLoaded(nextLoaded);
      setErrors(nextErrors);
    };
    void load();
    return () => {
      stale = true;
    };
  }, [enabled, waiting, revision]);

  // A held relay can arrive while the agent already needs the user, which moves nothing on the roster.
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);
  const watchedIds = useMemo(() => new Set(enabled ? waiting.map(([id]) => id) : []), [enabled, waiting]);
  useSessionsEvents(watchedIds, event => {
    if (event.type !== 'held-relays') return;
    const id = event.sessionId;
    const key = currentKeys.current.get(id);
    if (key === undefined) return;
    loadSource(id, key).then(
      source => {
        if (unmounted.current) return;
        setLoaded(current => new Map(current).set(id, source));
        setErrors(current => withoutKey(current, id));
      },
      (error: unknown) => {
        if (!unmounted.current) setErrors(current => new Map(current).set(id, errorText(error)));
      }
    );
  });

  const byId = useMemo(() => {
    const tree = new Map<string, PendingDecision[]>();
    if (!enabled) return tree;
    for (const agent of agents) {
      if (agent.redacted) continue;
      const read = WAITING_STATES.has(agent.state) ? loaded.get(agent.id) : undefined;
      // Read under an older state: wait for the refetch rather than show what may already be resolved.
      const source = read?.key === refreshKeyOf(agent) ? read : undefined;
      const decisions = pendingDecisionsOf({
        session: agent,
        ...(source && { messages: source.messages, held: source.held }),
        processing: agent.state === 'working',
      });
      if (decisions.length > 0) tree.set(agent.id, decisions);
    }
    return tree;
  }, [enabled, agents, loaded]);

  const loadError = waiting.map(([id]) => errors.get(id)).find(error => error !== undefined) ?? null;
  return { byId, loadError, refresh };
}

function withoutKey<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not read what the agents are waiting on';
}
