import type { RendererErrorReport } from '@shared/devLog';
import type { DevLogSink } from './DevLogSink';
import { ERRORS_TAG } from './tags';

/** Pre-clip, so an enormous payload costs a slice rather than a regex pass. The sink clips again. */
const MAX_INPUT_CHARS = 2000;

/** Reports accepted per window, then dropped (and counted) until the window rolls over. */
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 10_000;

const KINDS: ReadonlySet<string> = new Set<RendererErrorReport['kind']>(['error', 'unhandledrejection']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, MAX_INPUT_CHARS) : undefined;
}

/** Narrow untrusted IPC input to a report, or null. Strings only; anything else is dropped. */
export function parseRendererErrorReport(input: unknown): RendererErrorReport | null {
  if (!input || typeof input !== 'object') return null;
  const { kind, message, name, location } = input as Record<string, unknown>;
  if (typeof kind !== 'string' || !KINDS.has(kind) || typeof message !== 'string') return null;
  const nameText = text(name);
  const locationText = text(location);
  return {
    kind: kind as RendererErrorReport['kind'],
    message: message.slice(0, MAX_INPUT_CHARS),
    ...(nameText ? { name: nameText } : {}),
    ...(locationText ? { location: locationText } : {}),
  };
}

/** The route only: the URL's hash, never its query or the file path before it. */
function route(url: string): string | undefined {
  const index = url.indexOf('#');
  return index === -1 ? undefined : url.slice(index, index + 200).split('?')[0];
}

/**
 * The handler for renderer-reported failures. Rate-limited because a render loop can throw per
 * frame; the drops are summarised in one record when the window rolls over.
 */
export function createRendererErrorHandler(sink: DevLogSink, now: () => number = Date.now) {
  let windowStart = 0;
  let accepted = 0;
  let dropped = 0;

  const flushDropped = () => {
    if (dropped === 0) return;
    const count = dropped;
    dropped = 0;
    sink.publishError(() => ({
      tags: ['renderer', ERRORS_TAG],
      message: `${count} renderer error reports dropped (rate limit)`,
      fields: { source: 'renderer', dropped: count },
    }));
  };

  return (input: unknown, senderUrl = ''): void => {
    const report = parseRendererErrorReport(input);
    if (!report) return;
    const at = now();
    if (at - windowStart >= RATE_WINDOW_MS) {
      flushDropped();
      windowStart = at;
      accepted = 0;
    }
    if (accepted >= RATE_LIMIT) {
      dropped++;
      return;
    }
    accepted++;
    const where = route(senderUrl);
    sink.publishError(() => ({
      tags: ['renderer', ERRORS_TAG],
      message: report.message,
      fields: {
        source: 'renderer',
        kind: report.kind,
        ...(report.name ? { name: report.name } : {}),
        ...(report.location ? { location: report.location } : {}),
        ...(where ? { route: where } : {}),
      },
    }));
  };
}
