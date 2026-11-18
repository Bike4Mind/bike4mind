import { isLocalUrl } from '@shared/browserUrl';
import type { BrowserTabSummary } from '@shared/ipc';

/** What each item of the tab strip's right-click menu closes. */
export type BrowserTabCloseAction = 'this' | 'others' | 'right' | 'all';

/** Why closing a tab would interrupt something: the model is using it, or it shows a local dev server. */
export type BrowserTabUse = 'agent' | 'dev-server';

/** The tabs an action closes, in strip order. Empty when the right-clicked tab is gone. */
export function tabsToClose(
  tabs: readonly BrowserTabSummary[],
  tabId: number,
  action: BrowserTabCloseAction
): BrowserTabSummary[] {
  const index = tabs.findIndex(tab => tab.id === tabId);
  if (index < 0) return [];
  if (action === 'this') return [tabs[index]];
  if (action === 'others') return tabs.filter(tab => tab.id !== tabId);
  if (action === 'right') return tabs.slice(index + 1);
  return [...tabs];
}

/**
 * Whether a tab is in use. `turnStartedAt` is when the open conversation's current reply began,
 * or null while none is running; 0 means one is running that this window did not see start, so
 * any tab the agent has ever used counts.
 */
export function browserTabUse(tab: BrowserTabSummary, turnStartedAt: number | null): BrowserTabUse | null {
  const usedAt = tab.agentUsedAt ?? 0;
  if (turnStartedAt !== null && usedAt > 0 && usedAt >= turnStartedAt) return 'agent';
  if (tab.url && isLocalUrl(tab.url)) return 'dev-server';
  return null;
}

/**
 * The order to close tabs in: the active one last, so the pane does not switch to each
 * neighbour in turn as the tabs around it go.
 */
export function closeOrder(ids: readonly number[], activeTabId: number | null): number[] {
  return [...ids.filter(id => id !== activeTabId), ...ids.filter(id => id === activeTabId)];
}
