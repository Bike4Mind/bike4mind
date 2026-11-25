import { ipcMain } from 'electron';
import { rendererErrorReportSchema } from '@shared/appShell';
import { IPC_CHANNELS } from '@shared/ipc';
import { rendererErrorLog } from './devlog/rendererErrors';

/**
 * Log what the renderer's top-level error boundary caught. Main's console is persisted to the
 * log file (see logFile.ts), which a packaged build has no other way to see.
 */
export function registerRendererErrorLog(): void {
  ipcMain.handle(IPC_CHANNELS.rendererReportError, (_event, payload: unknown) => {
    const report = rendererErrorReportSchema.safeParse(payload);
    if (!report.success) {
      console.warn('RENDERER: dropped a malformed error report');
      return;
    }
    rendererErrorLog.render(report.data);
    const { message, stack, componentStack, route } = report.data;
    console.error(
      `RENDERER: render error${route ? ` on ${route}` : ''}: ${message}`,
      ...(stack ? [`\n${stack}`] : []),
      ...(componentStack ? [`\nComponent stack:${componentStack}`] : [])
    );
  });
}
