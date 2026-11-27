import { RENDERER_ERROR_FIELD_MAX, type RendererErrorReport } from '@shared/appShell';

export type ErrorSummary = { message: string; stack?: string };

/** Anything can be thrown; this is what is shown, copied and logged for it. */
export function summarizeError(error: unknown): ErrorSummary {
  if (error instanceof Error) {
    return { message: error.message || error.name, ...(error.stack ? { stack: error.stack } : {}) };
  }
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

function clip(text: string): string {
  return text.length <= RENDERER_ERROR_FIELD_MAX ? text : text.slice(0, RENDERER_ERROR_FIELD_MAX);
}

export function buildRendererErrorReport(
  error: unknown,
  componentStack: string | null | undefined,
  route: string
): RendererErrorReport {
  const { message, stack } = summarizeError(error);
  return {
    message: clip(message),
    ...(stack ? { stack: clip(stack) } : {}),
    ...(componentStack ? { componentStack: clip(componentStack) } : {}),
    route: route.slice(0, 500),
  };
}

/** The text Copy details puts on the clipboard, for pasting into a bug report. */
export function formatErrorDetails(error: unknown, componentStack?: string | null): string {
  const { message, stack } = summarizeError(error);
  return [
    `Error: ${message}`,
    `Route: ${window.location.hash || '/'}`,
    `User agent: ${navigator.userAgent}`,
    ...(stack ? ['', stack] : []),
    ...(componentStack ? ['', `Component stack:${componentStack}`] : []),
  ].join('\n');
}

/** Log a caught render error here and in main's log, which a packaged build keeps on disk. */
export function reportRenderError(error: unknown, componentStack?: string | null): void {
  console.error('Render error caught by the app error boundary', error);
  // The mini window's preload exposes no window.b4m.
  if (typeof window.b4m === 'undefined') return;
  const report = buildRendererErrorReport(error, componentStack, window.location.hash || '/');
  window.b4m.reportRendererError(report).catch((reportError: unknown) => {
    console.warn('Could not send the render error to main', reportError);
  });
}
