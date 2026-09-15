import { useEffect, useRef, useState } from 'react';
import { AdminTab, SIDEBAR_SECTIONS, SIDEBAR_EXPANDED_STORAGE_KEY, findSectionKeyForTab } from './adminSidebarConfig';

const readStored = (): Record<string, boolean> | null => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_EXPANDED_STORAGE_KEY);
    return stored ? (JSON.parse(stored) as Record<string, boolean>) : null;
  } catch {
    // Malformed storage reads as no preference at all.
    return null;
  }
};

const persist = (sections: Record<string, boolean>) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_EXPANDED_STORAGE_KEY, JSON.stringify(sections));
  } catch {
    // Persistence is best-effort; ignore quota/serialization failures.
  }
};

/**
 * Which admin sidebar sections are open: the user's own choice, persisted, plus a
 * transient force-expand so a cross-section tab jump (Model Lifecycle in aiAgents
 * linking to Credit Analytics in userOps) does not land on a collapsed section.
 *
 * The two are held in SEPARATE state on purpose. toggleSection persists the whole
 * map, so a forced expansion folded into it would be written out by the next
 * unrelated toggle and permanently overwrite a section the admin deliberately
 * collapsed. The force also fires only on a tab CHANGE: on mount the stored
 * preference is the answer, whatever tab is active.
 */
export function useAdminSidebarSections(activeTab: AdminTab | string | null): {
  isExpanded: (key: string) => boolean;
  toggleSection: (key: string) => void;
} {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(() => {
    const stored = readStored();
    if (stored) return Object.fromEntries(SIDEBAR_SECTIONS.map(s => [s.key, stored[s.key] ?? false]));
    // No preference yet: open only the active tab's section so the sidebar opens
    // scannable instead of fully expanded.
    const activeKey = findSectionKeyForTab(activeTab);
    return Object.fromEntries(SIDEBAR_SECTIONS.map(s => [s.key, s.key === activeKey]));
  });

  // Navigation, not a preference: never persisted, and at most one at a time.
  const [forcedSection, setForcedSection] = useState<string | null>(null);
  const lastTab = useRef(activeTab);

  useEffect(() => {
    if (activeTab === lastTab.current) return;
    lastTab.current = activeTab;
    setForcedSection(findSectionKeyForTab(activeTab) ?? null);
  }, [activeTab]);

  const isExpanded = (key: string) => expandedSections[key] === true || forcedSection === key;

  const toggleSection = (key: string) => {
    // Read off what is on screen, so clicking a force-expanded section collapses
    // it (and drops the force) instead of toggling invisible state underneath it.
    const open = isExpanded(key);
    if (forcedSection === key) setForcedSection(null);
    setExpandedSections(prev => {
      const next = { ...prev, [key]: !open };
      persist(next);
      return next;
    });
  };

  return { isExpanded, toggleSection };
}
