import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from 'react';
import WhatsNewSliderModal from '../components/modals/WhatsNewSliderModal';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetModals } from '@client/app/hooks/data/modals';
import { useGetUserActivityCounters } from '@client/app/hooks/data/user';
import { filterModals } from '@client/app/components/modals/modalHelpers';
import { useStreamingState } from '@client/app/hooks/useStreamingState';
import { isAnyModalDialogOpen } from '@client/app/utils/anyDialogOpen';

type ModalType = 'WhatsNewSlider';

interface ModalTriggerContextType {
  triggerModalByTag: (tag: string, modalType?: ModalType) => void;
  resetTrigger: () => void;
  tagToTrigger: string | null;
  triggerCounter: number;
}

const ModalTriggerContext = createContext<ModalTriggerContextType | undefined>(undefined);

export const useModalTrigger = () => {
  const context = useContext(ModalTriggerContext);

  if (!context) {
    throw new Error('useModalTrigger must be used within a ModalTriggerProvider');
  }
  return context;
};

export const ModalTriggerProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [tagToTrigger, setTagToTrigger] = useState<string | null>(null);
  const [triggerCounter, setTriggerCounter] = useState<number>(0);
  const [modalType, setModalType] = useState<ModalType | undefined>(undefined);

  // Access modal data and counters for threshold checking
  const currentUser = useUser(s => s.currentUser);
  const modals = useGetModals();
  const counters = useGetUserActivityCounters(currentUser?.id);

  // Get refetch function to refresh modal data when tab becomes visible
  const refetchModals = modals.refetch;

  const triggerModalByTag = useCallback((tag: string, modalType?: ModalType) => {
    console.log('triggerModalByTag inside of TriggerContext:', tag);
    setModalType(modalType);
    setTagToTrigger(tag);
    setTriggerCounter(prevCounter => prevCounter + 1);
  }, []);

  const resetTrigger = useCallback(() => {
    setTagToTrigger(null);
    setModalType(undefined);
  }, []);

  // Page Visibility API: Auto-show What's New slider when user returns to tab after 5+ minutes
  // Only triggers if there are modals with 'whats-new' tag that should be shown based on their behavior settings
  useEffect(() => {
    const FIVE_MINUTES = 5 * 60 * 1000;
    const SETTLE_DELAY = 2500; // 2.5 seconds for user to settle after returning

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab became hidden - store timestamp
        localStorage.setItem('tab_last_hidden_at', Date.now().toString());
      } else {
        // Tab became visible - check if we should trigger What's New slider
        const lastHiddenAt = localStorage.getItem('tab_last_hidden_at');
        const lastTriggeredAt = localStorage.getItem('whats_new_last_auto_trigger');

        if (!lastHiddenAt) return; // Never been hidden, skip

        const hiddenDuration = Date.now() - parseInt(lastHiddenAt, 10);
        const timeSinceLastTrigger = lastTriggeredAt ? Date.now() - parseInt(lastTriggeredAt, 10) : Infinity;

        // Only trigger if:
        // 1. Tab was hidden for 5+ minutes
        // 2. Haven't triggered in the last 5 minutes (debounce)
        // 3. There are actually unseen What's New modals (respects threshold checks)
        if (hiddenDuration >= FIVE_MINUTES && timeSinceLastTrigger >= FIVE_MINUTES) {
          // Refetch to pick up modals created while the tab was hidden.
          const checkAndTriggerModals = async () => {
            if (process.env.NODE_ENV === 'development') {
              console.log('ModalTriggerContext: Refreshing modal data...');
            }

            try {
              // Refetch and use the returned data to avoid race condition
              const { data: freshModals } = await refetchModals();

              // Respect display-behavior thresholds (First Time Only, Weekly, etc.)
              // before triggering.
              if (!freshModals || !currentUser || counters.isPending || !counters.data) {
                if (process.env.NODE_ENV === 'development') {
                  console.log('ModalTriggerContext: Data not ready, skipping trigger');
                }
                return; // Data not ready, skip trigger
              }

              // Filter WITHOUT forcedTags: passing forcedTags would bypass checkModalThresholds().
              const filteredModals = filterModals(freshModals, currentUser, counters.data, undefined);

              // Only include What's New modals with matching tag, excluding banners
              const unseenWhatsNewModals = filteredModals.filter(
                modal => modal.tags?.includes('whats-new') && !modal.isBanner
              );

              // If no unseen What's New modals, don't trigger
              if (unseenWhatsNewModals.length === 0) {
                if (process.env.NODE_ENV === 'development') {
                  console.log("ModalTriggerContext: No unseen What's New modals, skipping auto-trigger");
                }
                return;
              }

              if (process.env.NODE_ENV === 'development') {
                console.log(
                  `ModalTriggerContext: Auto-triggering ${unseenWhatsNewModals.length} unseen What's New modal(s)`
                );
              }

              // Don't interrupt the user while busy: active stream, active composing, or any
              // open modal/dialog. The chat composer is a Lexical contenteditable div (not a
              // <textarea>), so check both. Return without stamping the debounce timestamp so the
              // next qualifying visibility change retries once the user is idle.
              const activeEl = document.activeElement;
              const isComposing =
                (activeEl instanceof HTMLTextAreaElement && activeEl.value.trim().length > 0) ||
                (activeEl instanceof HTMLElement &&
                  activeEl.isContentEditable &&
                  (activeEl.textContent ?? '').trim().length > 0);
              const anyDialogOpen = isAnyModalDialogOpen();
              if (useStreamingState.getState().isAnyStreaming() || isComposing || anyDialogOpen) {
                if (process.env.NODE_ENV === 'development') {
                  console.log('ModalTriggerContext: user busy (streaming/composing/modal), deferring auto-trigger');
                }
                return;
              }

              triggerModalByTag('whats-new', 'WhatsNewSlider');
              localStorage.setItem('whats_new_last_auto_trigger', Date.now().toString());
            } catch (error) {
              console.error('ModalTriggerContext: Failed to refetch modals', error);
              // Fail gracefully - don't trigger modal if refetch fails
            }
          };

          // Use setTimeout with cancellation flag to prevent state updates after unmount
          let cancelled = false;
          const timeoutId = setTimeout(() => {
            if (!cancelled) {
              checkAndTriggerModals();
            }
          }, SETTLE_DELAY);

          // Clean up timeout and cancel async operations if component unmounts during delay
          return () => {
            cancelled = true;
            clearTimeout(timeoutId);
          };
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [triggerModalByTag, modals.data, currentUser, counters.isPending, counters.data, refetchModals]);

  const contextValue = useMemo(
    () => ({ triggerModalByTag, resetTrigger, tagToTrigger, triggerCounter }),
    [triggerModalByTag, resetTrigger, tagToTrigger, triggerCounter]
  );

  return (
    <ModalTriggerContext.Provider value={contextValue}>
      {tagToTrigger && modalType === 'WhatsNewSlider' && (
        <WhatsNewSliderModal tagToTrigger={tagToTrigger} key={triggerCounter} />
      )}
      {children}
    </ModalTriggerContext.Provider>
  );
};
