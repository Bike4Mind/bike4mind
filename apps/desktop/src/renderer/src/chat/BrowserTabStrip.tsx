import { useState } from 'react';
import { MAX_BROWSER_TABS } from '@shared/browserTabs';
import type { BrowserTabSummary } from '@shared/ipc';
import type { BrowserTabUse } from './browserTabClose';
import { BrowserTabMenu, type BrowserTabMenuRequest } from './BrowserTabMenu';
import { TabStrip } from './TabStrip';

/** What a tab with no title yet is called: a host while it loads, "New tab" before it has been anywhere. */
export function browserTabLabel(tab: BrowserTabSummary): string {
  if (tab.title) return tab.title;
  if (!tab.url) return 'New tab';
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

/**
 * The tabs of a conversation's browser, above its url bar.
 *
 * A dot rather than a favicon: the renderer's CSP allows no remote images, and fetching icons
 * through main would be a request per tab per page for a few pixels. The dot turns to the
 * primary colour while its tab loads, which is the part of a favicon that carries information.
 */
export function BrowserTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
  inUse,
  onCloseTabs,
}: {
  tabs: readonly BrowserTabSummary[];
  activeTabId: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  /** Whether closing a tab would interrupt something; the right-click menu asks before closing those. */
  inUse: (tab: BrowserTabSummary) => BrowserTabUse | null;
  onCloseTabs: (ids: number[]) => void;
}) {
  const [menu, setMenu] = useState<BrowserTabMenuRequest | null>(null);
  return (
    <>
      <TabStrip
        tabs={tabs.map(tab => {
          const label = browserTabLabel(tab);
          return {
            id: tab.id,
            label,
            title: tab.url && tab.url !== label ? `${label}\n${tab.url}` : label,
            busy: tab.loading,
          };
        })}
        activeId={activeTabId}
        ariaLabel="Browser tabs"
        testIdPrefix="browser"
        newDisabledTitle={tabs.length >= MAX_BROWSER_TABS ? `At most ${MAX_BROWSER_TABS} tabs` : undefined}
        onSelect={onSelect}
        onClose={onClose}
        onNew={onNew}
        onContextMenu={(tabId, at) => setMenu({ tabId, ...at })}
      />
      <BrowserTabMenu
        tabs={tabs}
        request={menu}
        label={browserTabLabel}
        inUse={inUse}
        onDismiss={() => setMenu(null)}
        onCloseTabs={onCloseTabs}
      />
    </>
  );
}
