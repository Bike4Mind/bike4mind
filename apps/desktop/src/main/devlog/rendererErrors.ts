import type { RendererErrorReport } from '@shared/appShell';
import type { DevLogErrorReport } from '@shared/devLog';
import { devLog, type DevLogSink } from './DevLogSink';
import { ERRORS_TAG } from './tags';

/** Pre-clip, so an enormous payload costs a slice rather than a regex pass. The sink clips again. */
const MAX_INPUT_CHARS = 2000;

/** Reports accepted per window, then dropped (and counted) until the window rolls over. */
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 10_000;

const KINDS: ReadonlySet<string> = new Set<DevLogErrorReport['kind']>(['error', 'unhandledrejection']);

const NO_MESSAGE = '(no message)';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, MAX_INPUT_CHARS) : undefined;
}

/** Narrow untrusted IPC input to a report, or null. Strings only; anything else is dropped. */
export function parseRendererErrorReport(input: unknown): DevLogErrorReport | null {
  if (!input || typeof input !== 'object') return null;
  const { kind, message, name, location } = input as Record<string, unknown>;
  if (typeof kind !== 'string' || !KINDS.has(kind) || typeof message !== 'string') return null;
  const messageText = message.slice(0, MAX_INPUT_CHARS) || NO_MESSAGE;
  const nameText = text(name);
  const locationText = text(location);
  return {
    kind: kind as DevLogErrorReport['kind'],
    message: messageText,
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
 * Handlers for renderer-reported failures, sharing one rate limit: `report` takes the devlog
 * channel's untrusted input, `render` takes what the render error boundary sends main. Rate-limited
 * because a render loop can throw per frame; the drops are summarised in one record when the
 * window ends, even if no further report arrives.
 */
export function createRendererErrorHandler(sink: DevLogSink, now: () => number = Date.now) {
  let windowStart = 0;
  let accepted = 0;
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flushDropped = () => {
    clearTimeout(timer);
    timer = undefined;
    if (dropped === 0) return;
    const count = dropped;
    dropped = 0;
    sink.publishError(() => ({
      tags: ['renderer', ERRORS_TAG],
      message: `${count} renderer error reports dropped (rate limit)`,
      fields: { source: 'renderer', dropped: count },
    }));
  };

  /** True when the report fits the current window. */
  const admit = (): boolean => {
    const at = now();
    if (at - windowStart >= RATE_WINDOW_MS) {
      flushDropped();
      windowStart = at;
      accepted = 0;
    }
    if (accepted >= RATE_LIMIT) {
      dropped++;
      timer ??= setTimeout(flushDropped, Math.max(0, windowStart + RATE_WINDOW_MS - at));
      timer.unref?.();
      return false;
    }
    accepted++;
    return true;
  };

  const publish = (message: string, fields: Record<string, string>) =>
    sink.publishError(() => ({ tags: ['renderer', ERRORS_TAG], message, fields: { source: 'renderer', ...fields } }));

  return {
    report(input: unknown, senderUrl = ''): void {
      const report = parseRendererErrorReport(input);
      if (!report || !admit()) return;
      const where = route(senderUrl);
      publish(report.message, {
        kind: report.kind,
        ...(report.name ? { name: report.name } : {}),
        ...(report.location ? { location: report.location } : {}),
        ...(where ? { route: where } : {}),
      });
    },
    /** The stack and component stack stay in main's log file, not the record. */
    render(report: RendererErrorReport): void {
      if (!admit()) return;
      const where = report.route ? (route(report.route) ?? report.route.split('?')[0]) : undefined;
      publish(report.message.slice(0, MAX_INPUT_CHARS) || NO_MESSAGE, {
        kind: 'render',
        ...(where ? { route: where } : {}),
      });
    },
  };
}

/** The app's instance, over the shared sink. */
export const rendererErrorLog = createRendererErrorHandler(devLog);
