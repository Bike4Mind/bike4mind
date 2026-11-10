import { create } from 'zustand';
import type { ICustomPageDocument } from '@bike4mind/common';
import { registerSurfaceChatContextProvider, type SurfaceChatContext } from '@client/app/utils/surfaceChatContext';

export const PAGE_CONTEXT_STATE_MAX_CHARS = 4096;

interface ActiveCustomPageState {
  page: ICustomPageDocument | null;
  /** The chat session the user is looking at; context applies only while it is the page's own chat. */
  currentSessionId: string | null;
}

export const useActiveCustomPage = create<ActiveCustomPageState>(() => ({ page: null, currentSessionId: null }));

export function setActiveCustomPage(page: ICustomPageDocument | null, currentSessionId: string | null): void {
  useActiveCustomPage.setState({ page, currentSessionId });
}

export function clearActiveCustomPage(): void {
  useActiveCustomPage.setState({ page: null, currentSessionId: null });
}

export function buildPageBriefContext(page: ICustomPageDocument): string {
  const stateJson = JSON.stringify(page.state ?? {});
  const state =
    stateJson.length > PAGE_CONTEXT_STATE_MAX_CHARS
      ? `${stateJson.slice(0, PAGE_CONTEXT_STATE_MAX_CHARS)}... (truncated; call page_get_state for the full state)`
      : stateJson;
  const widgets = page.widgets.length
    ? page.widgets.map(w => `- ${w.id} (${w.type})${w.title ? `: ${w.title}` : ''}`).join('\n')
    : '- (none yet)';
  return [
    `The user is on their custom page "${page.name}".`,
    `Page state: ${state}`,
    `Widgets on the page:\n${widgets}`,
    'Use page_get_state, page_update_state and page_set_widget to read and change this page.',
  ].join('\n');
}

export function getPageChatContext(): SurfaceChatContext {
  const { page, currentSessionId } = useActiveCustomPage.getState();
  if (!page || typeof window === 'undefined') return {};
  if (!window.location.pathname.startsWith('/pages/')) return {};
  if (currentSessionId !== page.orchestratorSessionId) return {};
  // briefContext only: a viewDescription here would override navigate_view's own description.
  return { briefContext: buildPageBriefContext(page) };
}

registerSurfaceChatContextProvider(getPageChatContext);
