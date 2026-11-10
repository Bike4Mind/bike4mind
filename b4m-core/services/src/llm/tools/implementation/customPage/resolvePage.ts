import type { ToolContext } from '../../base/types';
import type { CustomPageToolPage, CustomPageToolPort } from './port';
import type { CustomPageResult } from '../../../../customPageService/ports';

export type ResolvedPage = { port: CustomPageToolPort; page: CustomPageToolPage } | { error: string };

/** Resolves the page for the current session; a forged or foreign session gets an error, never a page. */
export async function resolvePage(context: ToolContext): Promise<ResolvedPage> {
  const port = context.db.customPages;
  if (!port) return { error: 'Error: custom pages are not configured in this environment.' };
  if (!context.sessionId) return { error: 'Error: no page is attached to this session.' };
  const page = await port.findForSession(context.sessionId, context.userId);
  if (!page) return { error: 'Error: there is no page for this session, so nothing was changed.' };
  return { port, page };
}

export function describeFailure(result: Extract<CustomPageResult, { ok: false }>): string {
  const issues = result.issues?.length ? `\n- ${result.issues.join('\n- ')}` : '';
  return `Error: ${result.message}${issues}`;
}
