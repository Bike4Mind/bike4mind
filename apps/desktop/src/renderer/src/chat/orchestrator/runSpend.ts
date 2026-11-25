import { useEffect, useState } from 'react';
import type { CompletionRunUsage } from '@bike4mind/common';
import type { RunSpend } from '@shared/runSpend';
import { formatAgentCost } from './roster';

/** The job summary's spend: a chip for the finale card and the lines that explain it. */
export interface RunSpendView {
  chip: string;
  lines: string[];
  /** The server's turn charges equal what this device recorded under the run. */
  reconciled: boolean;
}

type Purpose = CompletionRunUsage['byPurpose'][number]['purpose'];

const PURPOSE_LABELS: Record<Purpose, string> = {
  turn: 'Turns',
  explore: 'Exploration',
  title: 'Titles',
  compaction: 'Summaries',
  suggestion: 'Suggestions',
  review: 'Reviews',
  tool: 'Paid tools',
};

const credits = (value: number) => formatAgentCost(undefined, value);
const SEPARATOR = ' \u00b7 ';
// Credits are fractional; a difference this small is float noise, not a missing charge.
const EPSILON = 1e-6;

function roleLine(usage: CompletionRunUsage): string {
  const root = usage.byRole.find(entry => entry.role === 'root');
  const workers = usage.byRole.find(entry => entry.role === 'worker');
  const attempts = usage.byAttempt.filter(entry => entry.role === 'worker').length;
  const parts = [
    root && `Root ${credits(root.creditsCharged)}`,
    workers &&
      `Workers ${credits(workers.creditsCharged)} over ${attempts}${usage.byAttemptTruncated ? '+' : ''} ${
        attempts === 1 && !usage.byAttemptTruncated ? 'attempt' : 'attempts'
      }`,
  ];
  return parts.filter(Boolean).join(SEPARATOR);
}

function purposeLine(usage: CompletionRunUsage): string {
  return usage.byPurpose
    .filter(entry => entry.creditsCharged > 0)
    .map(entry => `${PURPOSE_LABELS[entry.purpose]} ${credits(entry.creditsCharged)}`)
    .join(SEPARATOR);
}

/**
 * What the finale says about a run's spend; undefined when the server has nothing for it, which
 * leaves the card on its local estimate. The server's total is authoritative. This device's own
 * record is compared against the TURN charges only, because helper calls settle without a reply
 * to store their charge on.
 */
export function describeRunSpend(spend: RunSpend | undefined): RunSpendView | undefined {
  if (spend?.status === 'unavailable') {
    // Nothing recorded under the run is unknown, not zero: the card keeps its own estimate.
    if (spend.local.requests === 0) return undefined;
    return {
      chip: `~${credits(spend.local.creditsCharged)} (this device)`,
      lines: ['Server total unavailable; this device can miss helper calls and dropped requests'],
      reconciled: false,
    };
  }
  // Match `settled` explicitly: the value crosses IPC, so anything unrecognised keeps the estimate.
  if (spend?.status !== 'settled') return undefined;
  const { server, local } = spend;
  const turns = server.byPurpose.find(entry => entry.purpose === 'turn')?.creditsCharged ?? 0;
  const reconciled = Math.abs(turns - local.creditsCharged) < EPSILON;
  const lines = [
    roleLine(server),
    purposeLine(server),
    reconciled
      ? 'Turn charges match what this device recorded'
      : `This device recorded ${credits(local.creditsCharged)} of the ${credits(turns)} in turn charges`,
    `Server total as of ${formatCheckedAt(spend.checkedAt)}`,
  ].filter(Boolean);
  return { chip: `${credits(server.settled.creditsCharged)} settled`, lines, reconciled };
}

export function formatCheckedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * When the summary reads the run again, in ms. The root's title and next-prompt suggestion can
 * settle up to TITLE_TIMEOUT_MS (15s) after the run goes idle, after the first read; one bounded
 * re-read picks them up.
 */
export const RUN_SPEND_REREAD_MS = 20_000;

/** Reads the run's spend when `active` turns true (the finale is up), once more after RUN_SPEND_REREAD_MS. */
export function useRunSpend(rootSessionId: string | undefined, active: boolean): RunSpendView | undefined {
  const [view, setView] = useState<RunSpendView | undefined>(undefined);
  useEffect(() => {
    setView(undefined);
    if (!rootSessionId || !active) return;
    let current = true;
    const read = () =>
      window.b4m.chat
        .getRunSpend(rootSessionId)
        .then(spend => {
          if (current) setView(previous => describeRunSpend(spend) ?? previous);
        })
        .catch((err: unknown) => {
          // The card keeps its local estimate; the summary is never worth an error of its own.
          console.warn('Could not read the run spend', err);
        });
    void read();
    const reread = setTimeout(() => void read(), RUN_SPEND_REREAD_MS);
    return () => {
      current = false;
      clearTimeout(reread);
    };
  }, [rootSessionId, active]);
  return view;
}
