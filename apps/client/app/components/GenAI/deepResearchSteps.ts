import type { IChatHistoryItem } from '@bike4mind/common';

type DeepResearchState = NonNullable<IChatHistoryItem['deepResearchState']>;
export type DeepResearchActivity = DeepResearchState['activities'][number];
export type DeepResearchSource = DeepResearchState['sources'][number] & { type?: string };

export type StepStatus = 'pending' | 'complete' | 'error';

interface StepBase {
  id: string;
  status: StepStatus;
  /** Seconds from the start of the run to when this step began. */
  elapsedSec: number;
}

export type ResearchStep =
  | (StepBase & { kind: 'search'; query: string; resultCount?: number; error?: string })
  | (StepBase & { kind: 'read'; url: string; sourceIndex?: number; error?: string })
  | (StepBase & { kind: 'analyze' | 'write' | 'note'; detail: string });

// These patterns mirror the activity messages written by deep research in
// b4m-core/services/src/llm/tools/implementation/deepResearch/index.ts; keep them in sync.
const SEARCH_STARTED = /^Searching with .+? for: "([\s\S]*)"$/;
const SEARCH_FOUND = /^.+? found (\d+) results for: "([\s\S]*)"$/;
const SEARCH_FAILED = /^.+? search failed: ([\s\S]*)$/;
const EXTRACT_STARTED = /^Extracting content from (\S+)$/;
const EXTRACT_DONE = /^Successfully extracted content from (\S+)$/;
const EXTRACT_FAILED = /^Failed to extract content from (\S+)$/;
const EXTRACT_SKIPPED_PDF = /^Skipped PDF .*?: (\S+)$/;

/**
 * Folds the raw activity log into one step per thing the run did: a search's "started" and
 * "found N" events become a single search step, a page's extract events a single read step.
 * The searcher's name is dropped on the way - it is an implementation detail, not progress.
 */
export function buildResearchSteps(
  activities: DeepResearchActivity[],
  sources: DeepResearchSource[],
  startMs: number
): ResearchStep[] {
  const steps: ResearchStep[] = [];
  const sourceIndexByUrl = new Map<string, number>();
  sources.forEach((s, i) => {
    if (s.url && !sourceIndexByUrl.has(s.url)) sourceIndexByUrl.set(s.url, i + 1);
  });
  const elapsedOf = (a: DeepResearchActivity) =>
    Math.max(0, Math.floor((Date.parse(a.timestamp) - startMs) / 1000)) || 0;
  const lastOpen = <K extends ResearchStep['kind']>(
    kind: K,
    match?: (s: Extract<ResearchStep, { kind: K }>) => boolean
  ) => {
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.kind === kind && s.status === 'pending' && (!match || match(s as Extract<ResearchStep, { kind: K }>))) {
        return s as Extract<ResearchStep, { kind: K }>;
      }
    }
    return undefined;
  };

  activities.forEach((a, i) => {
    const base = { id: `${i}`, elapsedSec: elapsedOf(a) };
    const msg = a.message ?? '';

    if (a.type === 'search') {
      const started = msg.match(SEARCH_STARTED);
      if (started) {
        steps.push({ ...base, kind: 'search', status: 'pending', query: started[1] });
        return;
      }
      const found = msg.match(SEARCH_FOUND);
      if (found) {
        const open = lastOpen('search', s => s.query === found[2]) ?? lastOpen('search');
        if (open) {
          open.status = 'complete';
          open.resultCount = Number(found[1]);
        } else {
          steps.push({ ...base, kind: 'search', status: 'complete', query: found[2], resultCount: Number(found[1]) });
        }
        return;
      }
      const failed = msg.match(SEARCH_FAILED);
      const open = lastOpen('search');
      if (open) {
        open.status = 'error';
        open.error = failed ? failed[1] : msg;
      } else {
        steps.push({ ...base, kind: 'note', status: 'error', detail: failed ? `Search failed: ${failed[1]}` : msg });
      }
      return;
    }

    if (a.type === 'extract') {
      const started = msg.match(EXTRACT_STARTED);
      if (started) {
        steps.push({
          ...base,
          kind: 'read',
          status: 'pending',
          url: started[1],
          sourceIndex: sourceIndexByUrl.get(started[1]),
        });
        return;
      }
      const done = msg.match(EXTRACT_DONE);
      const failed = msg.match(EXTRACT_FAILED);
      const skipped = msg.match(EXTRACT_SKIPPED_PDF);
      const url = (done ?? failed ?? skipped)?.[1];
      const open = url ? lastOpen('read', s => s.url === url) : undefined;
      if (open) {
        open.status = done ? 'complete' : 'error';
        if (!done) open.error = skipped ? 'PDF skipped' : "Couldn't read this page";
      } else if (url) {
        steps.push({
          ...base,
          kind: 'read',
          status: done ? 'complete' : 'error',
          url,
          sourceIndex: sourceIndexByUrl.get(url),
          error: done ? undefined : skipped ? 'PDF skipped' : "Couldn't read this page",
        });
      } else {
        steps.push({ ...base, kind: 'note', status: a.status, detail: msg });
      }
      return;
    }

    if (a.type === 'analyze' || a.type === 'synthesis') {
      const kind = a.type === 'analyze' ? 'analyze' : 'write';
      const open = lastOpen(kind);
      if (a.status === 'pending' || !open) {
        steps.push({ ...base, kind, status: a.status, detail: a.status === 'pending' ? '' : msg });
        return;
      }
      open.status = a.status;
      // The write step's closing message is a bare "Research completed"; the step title says it.
      if (kind === 'analyze' || a.status === 'error') open.detail = msg;
      return;
    }

    steps.push({ ...base, kind: 'note', status: a.status, detail: msg });
  });

  return steps;
}

export function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function formatElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
