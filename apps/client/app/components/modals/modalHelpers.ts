import { IModal, IUser, IUserActivityCounterDocument } from '@bike4mind/common';

/**
 * Local storage utilities for modal display tracking
 */
export const modalStorage = {
  getLastShownTime: (modalId: string): number => {
    const storedTime = localStorage.getItem(`modal_last_shown_${modalId}`);
    return storedTime ? parseInt(storedTime, 10) : 0;
  },
  setLastShownTime: (modalId: string) => {
    localStorage.setItem(`modal_last_shown_${modalId}`, Date.now().toString());
  },
};

/**
 * Tracks modal IDs we've already warned about for the implicit firstTime
 * default, so admins see one warning per modal instead of one per render.
 */
const warnedUnconfiguredModalIds = new Set<string>();

/**
 * Checks if a modal should be shown based on its threshold configuration and user activity counters.
 *
 * Supports 4 explicit behavior types:
 * - persistent: Show until user agrees (requires agreeButton)
 * - firstTime: Show once only
 * - weekly: Show every 7 days
 * - custom: Show until custom threshold reached
 *
 * If no behavior type is configured (both `numberOfViews` and `numberOfAgrees`
 * are null/unset), the modal implicitly defaults to firstTime - it shows once
 * and then hides forever. A console.warn is emitted once per modal ID so
 * admins can audit modals relying on this implicit default.
 *
 * @param modal - The modal configuration
 * @param counters - User activity counters (views and agrees)
 * @returns true if modal should be shown, false otherwise
 */
const checkModalThresholds = (modal: IModal, counters: IUserActivityCounterDocument[]): boolean => {
  const modalId = modal._id;
  if (!modalId) return true; // No ID, show modal

  // Find counters for this specific modal (modal ID stored in counter tags)
  const modalViewCounter = counters?.find(c => c.action === 'Modal Viewed' && c.tags?.includes(modalId));
  const modalAgreeCounter = counters?.find(c => c.action === 'Modal Agreed To' && c.tags?.includes(modalId));

  // Determine behavior type from modal configuration
  const viewType = modal.numberOfViews?.type || '';
  const agreeType = modal.numberOfAgrees?.type || '';

  // PERSISTENT BEHAVIOR: Show until user agrees (threshold 999)
  // Only check agree counter, ignore view counter
  // Persistent modals should have agreeButton: true for proper behavior
  if (viewType.startsWith('persistent') || agreeType.startsWith('persistent')) {
    // Validate that persistent modal has agree button configured
    if (!modal.agreeButton) {
      console.warn(
        `Modal "${modal.title}" has Persistent behavior but agreeButton is not enabled. ` +
          `It will show indefinitely without a way to dismiss it.`
      );
    }

    // If user has agreed, hide modal
    if (modalAgreeCounter && modalAgreeCounter.count >= 1) {
      return false;
    }
    // Keep showing until agreed
    return true;
  }

  // FIRST TIME ONLY: Show once, then never again (threshold 1)
  if (viewType.startsWith('firstTime')) {
    if (modalViewCounter && modalViewCounter.count >= 1) {
      return false; // Already viewed once, hide forever
    }
    return true;
  }

  // WEEKLY REMINDER: Show every 7 days (threshold 7)
  if (viewType.startsWith('weekly')) {
    if (!modalViewCounter) return true; // Never viewed, show it

    const lastViewedDate = new Date(modalViewCounter.updatedAt);
    const daysSinceView = (Date.now() - lastViewedDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceView < 7) {
      return false; // Viewed within last 7 days, hide it
    }
    return true; // 7+ days passed, show it again
  }

  // CUSTOM BEHAVIOR: Use threshold as defined
  if (viewType.startsWith('custom')) {
    const viewThreshold = modal.numberOfViews?.threshold ?? Infinity;
    if (modalViewCounter && modalViewCounter.count >= viewThreshold) {
      return false; // Exceeded custom threshold
    }
    return true;
  }

  // No behavior configured: default to firstTime (show once).
  if (!warnedUnconfiguredModalIds.has(modalId)) {
    warnedUnconfiguredModalIds.add(modalId);
    const label = modal.title || modalId;
    console.warn(
      `Modal "${label}" has no behavior type set (numberOfViews/numberOfAgrees). ` +
        `Defaulting to firstTime — it will hide after the first view. ` +
        `Configure a behavior type in admin to control how often it appears.`
    );
  }
  if (modalViewCounter && modalViewCounter.count >= 1) {
    return false;
  }
  return true;
};

/**
 * Filters and sorts modals based on user data, counters, and optional forced tags.
 *
 * Filtering logic:
 * - Always respects enabled flag
 * - If forcedTags provided, only returns modals with matching tags (exclusive)
 * - Otherwise applies standard filters: start/end dates, behavior thresholds
 * - Sorts by priority (descending)
 *
 * @param modals - All available modals
 * @param currentUser - Current user
 * @param counters - User activity counters
 * @param forcedTags - Optional array of tags for exclusive filtering (manual triggers)
 * @returns Filtered and sorted array of modals to display
 */
export const filterModals = (
  modals: IModal[],
  currentUser: IUser,
  counters: IUserActivityCounterDocument[],
  forcedTags?: string[]
): IModal[] => {
  return modals
    .sort((a, b) => b.priority - a.priority)
    .filter(modal => {
      // Always respect the enabled flag, even for forced modals
      if (!modal.enabled) return false;

      // Always check date bounds (even for forced tags) so expired modals
      // don't show in What's New slider or anywhere else
      const now = new Date();
      if (modal.startDate && new Date(modal.startDate) > now) return false;
      if (modal.endDate && new Date(modal.endDate) < now) return false;

      // If forced tags are provided, ONLY return modals with matching tags
      // When forcing tags, all other modals are excluded (exclusive filtering)
      if (forcedTags?.length) {
        const hasMatchingForcedTag = modal.tags?.length && modal.tags.some(tag => forcedTags.includes(tag));
        // Return immediately - don't apply standard filters to non-matching modals
        return hasMatchingForcedTag;
      }

      // Apply threshold checks for non-forced modals. Cooldown is behavior-specific, handled in checkModalThresholds.
      // Modal tags are for categorization and manual triggering only, not for user filtering
      // All modals are shown to all users (controlled by enabled flag, dates, and counter thresholds)

      return checkModalThresholds(modal, counters);
    });
};
