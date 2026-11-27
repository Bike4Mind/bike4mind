import type { CompletionRunUsage } from '@bike4mind/common';
import type { ChatMessage } from './chat';

/**
 * What this device recorded as settled under one server run: the `settled` charges its sessions
 * stored with that run id, each request counted once. A partial view by nature - a request whose
 * `settled` event never arrived (a dropped stream, a closed app) is on the server only.
 */
export interface LocalRunSettlement {
  creditsCharged: number;
  requests: number;
}

/**
 * An orchestration's spend as the job summary shows it.
 * - `unattributed`: the run never got a server id, so the server has nothing to report.
 * - `unavailable`: the server total could not be read; `local` is what this device saw.
 * - `settled`: the server's settled total, beside what this device recorded for comparison.
 */
export type RunSpend =
  | { status: 'unattributed' }
  | { status: 'unavailable'; runId: string; local: LocalRunSettlement; reason: string }
  | { status: 'settled'; runId: string; local: LocalRunSettlement; server: CompletionRunUsage; checkedAt: string };

type Settleable = Pick<ChatMessage, 'requestId' | 'settled' | 'rounds'>;

/**
 * Sums the settled charges `messages` carry under `runId`. A reply keeps its charge either on the
 * message or per round, never both; the request id still dedupes, so a copied message cannot count
 * twice. A charge stored without a run id was billed outside any run and is left out, which is also
 * what keeps a reused conversation's earlier spend out of this run.
 */
export function localRunSettlement(messages: Iterable<Settleable>, runId: string): LocalRunSettlement {
  const seen = new Set<string>();
  let creditsCharged = 0;
  let requests = 0;
  const add = (requestId: string | undefined, settled: Settleable['settled']) => {
    if (!settled || settled.runId !== runId) return;
    if (requestId) {
      if (seen.has(requestId)) return;
      seen.add(requestId);
    }
    creditsCharged += settled.creditsCharged;
    requests += 1;
  };
  for (const message of messages) {
    add(message.requestId, message.settled);
    for (const round of message.rounds ?? []) add(round.requestId, round.settled);
  }
  return { creditsCharged, requests };
}
