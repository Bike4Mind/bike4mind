import { MAX_BROWSER_TABS } from '@shared/browserTabs';
import type { BrowserTabSummary } from '@shared/ipc';
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
}: {
  tabs: readonly BrowserTabSummary[];
  activeTabId: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}) {
  return (
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
    />
  );
}
