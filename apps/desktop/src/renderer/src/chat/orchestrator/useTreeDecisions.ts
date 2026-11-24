import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatHeldRelay, ChatMessage } from '@shared/chat';
import { pendingDecisionsOf, type PendingDecision } from '@shared/pendingDecisions';
import { refreshKeyOf } from './AgentPeekDrawer';
import type { AgentState, AgentView } from './roster';

/** The states a decision can sit behind; the transcript of any other agent is never read. */
const WAITING_STATES: ReadonlySet<AgentState> = new Set(['needs-you', 'failed', 'stopped']);

type LoadedSource = { messages: readonly ChatMessage[]; held: readonly ChatHeldRelay[] };

export interface TreeDecisions {
  /** Each agent with something open, in roster order. */
  byId: ReadonlyMap<string, PendingDecision[]>;
  loadError: string | null;
  /** Read again now, after a resolve that may have left nothing to refetch on. */
  refresh(): void;
}

/**
 * Every pending decision across the roster's agents. A task question comes from the roster alone;
 * approvals, held relays and the last turn need the agent's transcript and held list, which are
 * read only for agents in a waiting state and again whenever one of them changes.
 */
export function useTreeDecisions(agents: readonly AgentView[], enabled = true): TreeDecisions {
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedSource>>(() => new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  const waiting = agents.filter(agent => !agent.redacted && WAITING_STATES.has(agent.state));
  const waitingKey = waiting.map(agent => `${agent.id}\t${refreshKeyOf(agent)}`).join('\n');
  const waitingIds = useMemo(() => waiting.map(agent => agent.id), [waitingKey]);

  useEffect(() => {
    if (!enabled || waitingIds.length === 0) {
      setLoaded(new Map());
      return;
    }
    let stale = false;
    const load = async () => {
      const results = await Promise.allSettled(
        waitingIds.map(async id => {
          const [session, held] = await Promise.all([
            window.b4m.chat.getSession(id, false),
            window.b4m.chat.getHeldRelays(id),
          ]);
          return [id, { messages: session?.messages ?? [], held }] as const;
        })
      );
      if (stale) return;
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      setLoadError(failed ? errorText(failed.reason) : null);
      setLoaded(new Map(results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))));
    };
    void load();
    return () => {
      stale = true;
    };
  }, [enabled, waitingIds, revision]);

  // A held relay can arrive while the agent already needs the user, which moves nothing on the roster.
  useEffect(() => {
    if (!enabled || waitingIds.length === 0) return;
    const ids = new Set(waitingIds);
    return window.b4m.chat.onStreamEvent(event => {
      if (event.type === 'held-relays' && ids.has(event.sessionId)) refresh();
    });
  }, [enabled, waitingIds, refresh]);

  const byId = useMemo(() => {
    const tree = new Map<string, PendingDecision[]>();
    if (!enabled) return tree;
    for (const agent of agents) {
      if (agent.redacted) continue;
      const source = WAITING_STATES.has(agent.state) ? loaded.get(agent.id) : undefined;
      const decisions = pendingDecisionsOf({
        session: agent,
        ...source,
        processing: agent.state === 'working',
      });
      if (decisions.length > 0) tree.set(agent.id, decisions);
    }
    return tree;
  }, [enabled, agents, loaded]);

  return { byId, loadError, refresh };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not read what the agents are waiting on';
}
