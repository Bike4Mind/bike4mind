import type { ICustomPageDocument } from '@bike4mind/common';
import type { CustomPageResult } from '../../../../customPageService/ports';

/** Page snapshot a tool needs; `id` is the page id the mutating methods take. */
export type CustomPageToolPage = Pick<ICustomPageDocument, 'name' | 'state' | 'widgets'> & { id: string };

/**
 * Host seam for the page_* tools. Every call is scoped to `userId`; mutations also push a live
 * refresh to the page's open browser tabs. Built in apps/client/server/customPages/customPageToolPort.ts.
 */
export interface CustomPageToolPort {
  /** The page whose orchestrator session is `sessionId`, or null (also for a session the user does not own). */
  findForSession(sessionId: string, userId: string): Promise<CustomPageToolPage | null>;
  patchState(params: { pageId: string; userId: string; patch: Record<string, unknown> }): Promise<CustomPageResult>;
  setWidget(params: { pageId: string; userId: string; widget: unknown }): Promise<CustomPageResult>;
  removeWidget(params: { pageId: string; userId: string; widgetId: string }): Promise<CustomPageResult>;
}
