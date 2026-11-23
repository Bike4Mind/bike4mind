import type { RendererErrorReport } from '@shared/devLog';

type Report = (report: RendererErrorReport) => void;

/**
 * Forward uncaught renderer errors and unhandled promise rejections to the developer log.
 *
 * A no-op without the preload API, and a throwing reporter is swallowed: this runs inside the
 * error path, so it must never raise another error into it.
 */
export function installErrorReporting(
  target: Pick<Window, 'addEventListener'> = window,
  report: Report | undefined = window.b4m?.devLog?.reportError
): void {
  if (!report) return;
  const send = (payload: RendererErrorReport) => {
    try {
      report(payload);
    } catch {
      // Nothing useful to do; see above.
    }
  };

  target.addEventListener('error', event => {
    const { message, error, filename, lineno, colno } = event as ErrorEvent;
    send({
      kind: 'error',
      message: error instanceof Error ? error.message || message : message || 'Uncaught error',
      ...(error instanceof Error && error.name ? { name: error.name } : {}),
      ...(filename ? { location: `${filename}:${lineno}:${colno}` } : {}),
    });
  });

  target.addEventListener('unhandledrejection', event => {
    const { reason } = event as PromiseRejectionEvent;
    send({
      kind: 'unhandledrejection',
      message: reason instanceof Error ? reason.message || reason.name : String(reason),
      ...(reason instanceof Error ? { name: reason.name } : {}),
    });
  });
}
