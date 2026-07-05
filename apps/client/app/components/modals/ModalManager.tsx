import React, { useEffect, useCallback, useMemo, useRef, useReducer } from 'react';
import GenericModal from './GenericModal';
import { IModal, ModalEvents } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserActivityCounters } from '@client/app/hooks/data/user';
import { useGetModals } from '@client/app/hooks/data/modals';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { useModalTrigger } from '@client/app/contexts/ModalTriggerContext';
import { useRouter } from '@tanstack/react-router';
import BannerModal from './BannerModal';
import { useGetPresignedUrl } from '@client/app/hooks/data/fabFiles';
import { useQueryClient } from '@tanstack/react-query';
import { modalStorage, filterModals } from './modalHelpers';
import { isBrandNewAccount } from '@client/app/utils/onboarding';
import { useStreamingState } from '@client/app/hooks/useStreamingState';
import { isAnyModalDialogOpen } from '@client/app/utils/anyDialogOpen';

// Reducer types and function

type ModalManagerState = {
  modalQueue: IModal[];
  banners: IModal[];
  activeModal: (IModal & { presignedUrl?: string; fetchedPresignedUrl?: boolean }) | null;
  isModalOpen: boolean;
  whatsNewShown: boolean;
};

type ModalManagerAction =
  | { type: 'SET_MODAL_QUEUE'; payload: IModal[] }
  | { type: 'SET_BANNERS'; payload: IModal[] }
  | { type: 'SET_ACTIVE_MODAL'; payload: (IModal & { presignedUrl?: string; fetchedPresignedUrl?: boolean }) | null }
  | { type: 'UPDATE_ACTIVE_MODAL_PRESIGNED_URL'; payload: { presignedUrl?: string; fetchedPresignedUrl: boolean } }
  | { type: 'SET_IS_MODAL_OPEN'; payload: boolean }
  | { type: 'SET_WHATS_NEW_SHOWN'; payload: boolean }
  | { type: 'CLOSE_MODAL'; payload: { nextModal: IModal | null } }
  | { type: 'REMOVE_BANNER'; payload: string }
  | { type: 'AUTO_TRIGGER_WHATS_NEW'; payload: { regularModals: IModal[]; newBanners: IModal[] } }
  | { type: 'MOVE_BANNER_TO_FRONT'; payload: string }
  | { type: 'UPDATE_QUEUE_AND_ACTIVE'; payload: { modalQueue: IModal[]; activeModal: IModal | null } };

const modalManagerReducer = (state: ModalManagerState, action: ModalManagerAction): ModalManagerState => {
  switch (action.type) {
    case 'SET_MODAL_QUEUE':
      return { ...state, modalQueue: action.payload };

    case 'SET_BANNERS':
      return { ...state, banners: action.payload };

    case 'SET_ACTIVE_MODAL':
      return { ...state, activeModal: action.payload };

    case 'UPDATE_ACTIVE_MODAL_PRESIGNED_URL':
      if (!state.activeModal) return state;
      return {
        ...state,
        activeModal: {
          ...state.activeModal,
          ...action.payload,
        },
      };

    case 'SET_IS_MODAL_OPEN':
      return { ...state, isModalOpen: action.payload };

    case 'SET_WHATS_NEW_SHOWN':
      return { ...state, whatsNewShown: action.payload };

    case 'CLOSE_MODAL':
      return {
        ...state,
        isModalOpen: false,
        modalQueue: state.modalQueue.slice(1),
        activeModal: action.payload.nextModal,
      };

    case 'REMOVE_BANNER':
      return {
        ...state,
        banners: state.banners.filter(b => b._id !== action.payload),
      };

    case 'AUTO_TRIGGER_WHATS_NEW':
      return {
        ...state,
        modalQueue: action.payload.regularModals,
        banners: action.payload.newBanners,
        activeModal: null,
        whatsNewShown: true,
      };

    case 'MOVE_BANNER_TO_FRONT': {
      const banner = state.banners.find(b => b._id === action.payload);
      if (!banner) return state;
      return {
        ...state,
        banners: [banner, ...state.banners.filter(b => b._id !== action.payload)],
      };
    }

    case 'UPDATE_QUEUE_AND_ACTIVE':
      return {
        ...state,
        modalQueue: action.payload.modalQueue,
        activeModal: action.payload.activeModal,
      };

    default:
      return state;
  }
};

const ModalManager: React.FC = () => {
  const currentUser = useUser(s => s.currentUser);
  const { resetTrigger, triggerModalByTag, tagToTrigger, triggerCounter } = useModalTrigger();
  const logEvent = useLogEvent();
  const counters = useGetUserActivityCounters(currentUser?.id);
  const modals = useGetModals();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { mutate: getPresignedUrl } = useGetPresignedUrl();

  // Consolidated state management with useReducer
  const [state, dispatch] = useReducer(modalManagerReducer, {
    modalQueue: [],
    banners: [],
    activeModal: null,
    isModalOpen: false,
    whatsNewShown: false,
  });

  const { modalQueue, banners, activeModal, isModalOpen, whatsNewShown } = state;

  const hasTriggeredRef = useRef(false); // Prevent infinite loop on auto-trigger (ref doesn't cause re-renders)

  // Don't auto-trigger What's New while a chat response is actively streaming. Subscribing to a
  // boolean keeps re-renders minimal, and the effect re-runs (deferring the open until idle) when
  // streaming ends because `isStreaming` is in its dependency array.
  const isStreaming = useStreamingState(s => s.isAnyStreaming());

  // Telemetry refs
  const previousQueueLengthRef = useRef<number>(0);
  const autoTriggerCountRef = useRef<number>(0);

  const isAdminPage = useMemo(() => {
    return router.state.location.pathname.includes('/admin');
  }, [router.state.location.pathname]);

  const handleCloseModal = useCallback(() => {
    // Log view for every modal with an id, regardless of numberOfViews config.
    // checkModalThresholds' implicit-firstTime default (modals without numberOfViews) relies
    // on this counter to hide the modal on subsequent loads - gating the log on numberOfViews
    // caused unconfigured modals to re-show on every page reload.
    if (activeModal?._id) {
      logEvent.mutate(
        { type: ModalEvents.VIEW_MODAL, metadata: { id: activeModal._id } },
        {
          onSuccess: () => {
            // Invalidate counter query to fetch fresh data with updated modal view count
            queryClient.invalidateQueries({ queryKey: ['users', currentUser?.id, 'activities'] });
          },
        }
      );
    }

    const nextModal = modalQueue[1] || null;
    dispatch({ type: 'CLOSE_MODAL', payload: { nextModal } });

    if (activeModal?._id) {
      modalStorage.setLastShownTime(activeModal._id);
    }
    if (modalQueue.length === 1) resetTrigger();
  }, [activeModal, logEvent, modalQueue, resetTrigger, queryClient, currentUser?.id]);

  const handleAgreeModal = useCallback(() => {
    // Unlike handleCloseModal, the agree log stays gated on numberOfAgrees: implicit-firstTime
    // only consults the view counter, so AGREE_MODAL is informational here and only meaningful
    // when the modal was configured with an agree behavior.
    if (activeModal?.numberOfAgrees) {
      logEvent.mutate(
        { type: ModalEvents.AGREE_MODAL, metadata: { id: activeModal._id } },
        {
          onSuccess: () => {
            // Invalidate counter query to fetch fresh data with updated modal agree count
            queryClient.invalidateQueries({ queryKey: ['users', currentUser?.id, 'activities'] });
          },
        }
      );
    }
    handleCloseModal();
  }, [activeModal, logEvent, handleCloseModal, queryClient, currentUser?.id]);

  const handleCloseBanner = useCallback(
    (bannerId: string) => {
      const banner = banners.find(b => b._id === bannerId);
      // Always log view if the banner has an id - see handleCloseModal for rationale.
      if (banner?._id) {
        logEvent.mutate(
          { type: ModalEvents.VIEW_BANNER, metadata: { id: banner._id } },
          {
            onSuccess: () => {
              // Invalidate counter query to fetch fresh data with updated banner view count
              queryClient.invalidateQueries({ queryKey: ['users', currentUser?.id, 'activities'] });
            },
          }
        );
      }
      dispatch({ type: 'REMOVE_BANNER', payload: bannerId });
      if (banner?._id) {
        modalStorage.setLastShownTime(banner._id);
      }
    },
    [banners, logEvent, queryClient, currentUser?.id]
  );

  // Effect 1: Filter modals, manage queue, and auto-trigger What's New if needed
  useEffect(() => {
    // Skip when What's New slider is active (handled by WhatsNewSliderModal exclusively)
    if (tagToTrigger === 'whats-new') return;

    // Wait for all data to load before filtering modals to prevent race conditions
    if (!modals.data || !currentUser || counters.isPending || isAdminPage) return;

    // Telemetry: Track filter performance
    const filterStartTime = performance.now();

    const forcedTags = tagToTrigger ? [tagToTrigger] : [];
    const filteredModals = filterModals(modals.data, currentUser, counters.data ?? [], forcedTags);
    const newBanners = filteredModals.filter(modal => modal.isBanner);
    const nonBannerModals = filteredModals.filter(modal => !modal.isBanner);

    // Separate What's New modals from regular modals
    const whatsNewModals = nonBannerModals.filter(m => m.tags?.includes('whats-new'));
    const regularModals = nonBannerModals.filter(m => !m.tags?.includes('whats-new'));

    const filterDuration = performance.now() - filterStartTime;

    // Telemetry: Log filter performance
    if (filterDuration > 10) {
      // Only log if filter takes more than 10ms
      logEvent.mutate(
        {
          type: ModalEvents.MODAL_MANAGER_PERFORMANCE,
          metadata: {
            metric: 'filter_duration',
            duration: filterDuration,
            modal_count: modals.data.length,
            filtered_count: filteredModals.length,
          },
        },
        {
          onError: () => {
            // Silently fail - telemetry should never impact user experience
          },
        }
      );
    }

    // Don't greet a brand-new user with a changelog of releases that predate them - their first
    // frame should be the workbench, not a "What's New" history. A freshly created account (within
    // the grace window) gets a clean first run; What's New resumes on their next visit.
    // (createdAt is persisted in UserContext so this survives a post-registration reload.)
    const brandNewAccount = isBrandNewAccount(currentUser?.createdAt);

    // Don't pop over a user who is actively composing. The main chat composer is a Lexical
    // contenteditable div (role="textbox"), not a <textarea>, so check both. Point-in-time check;
    // the effect re-runs on its other deps so a deferred open isn't lost.
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    const isComposing =
      (activeEl instanceof HTMLTextAreaElement && activeEl.value.trim().length > 0) ||
      (activeEl instanceof HTMLElement && activeEl.isContentEditable && (activeEl.textContent ?? '').trim().length > 0);

    // `isModalOpen` only reflects ModalManager's own GenericModal queue - other Joy modals
    // (HelpModal, ReferralModal, ...) render separately, so also defer if any modal/dialog is
    // actually visible. (Visibility, not DOM presence - Joy keeps closed drawers mounted.)
    const anyDialogOpen = isAnyModalDialogOpen();

    // Check if we should auto-trigger What's New slider. Defer while the user is busy: an active
    // chat stream, an open modal/dialog, or active composing - so we never interrupt them.
    const shouldAutoTrigger =
      whatsNewModals.length > 0 &&
      !hasTriggeredRef.current &&
      !tagToTrigger &&
      !brandNewAccount &&
      !isStreaming &&
      !isModalOpen &&
      !anyDialogOpen &&
      !isComposing;

    // Update banners (only if changed)
    if (banners.length !== newBanners.length || !banners.every((b, i) => b._id === newBanners[i]._id)) {
      dispatch({ type: 'SET_BANNERS', payload: newBanners });
    }

    // If auto-trigger is needed, handle it immediately to avoid race conditions
    if (shouldAutoTrigger) {
      hasTriggeredRef.current = true;
      autoTriggerCountRef.current += 1;

      // Telemetry: Track auto-trigger event
      logEvent.mutate(
        {
          type: ModalEvents.MODAL_MANAGER_AUTO_TRIGGER,
          metadata: {
            whats_new_count: whatsNewModals.length,
            regular_modals_count: regularModals.length,
            auto_trigger_count: autoTriggerCountRef.current,
            timestamp: Date.now(),
          },
        },
        {
          onError: () => {
            // Silently fail - telemetry should never impact user experience
          },
        }
      );

      // Dispatch auto-trigger action (sets modalQueue, banners, activeModal, whatsNewShown)
      dispatch({ type: 'AUTO_TRIGGER_WHATS_NEW', payload: { regularModals, newBanners } });

      // Trigger the slider
      triggerModalByTag('whats-new', 'WhatsNewSlider');
      return; // Exit early
    }

    // Reset hasTriggeredRef if no whats-new modals remain (counters have been updated)
    // This allows future auto-triggers to work after modals have been viewed
    if (hasTriggeredRef.current && whatsNewModals.length === 0) {
      hasTriggeredRef.current = false;
    }

    // Normal processing when no auto-trigger needed
    // IMPORTANT: Use regularModals (excludes whats-new) to prevent whats-new modals
    // from appearing in GenericModal if counters are stale

    // Only update modalQueue if changed
    if (modalQueue.length !== regularModals.length || !modalQueue.every((m, i) => m._id === regularModals[i]._id)) {
      dispatch({ type: 'SET_MODAL_QUEUE', payload: regularModals });
    }

    // Only update activeModal if changed
    const nextModal = regularModals[0] || null;
    if (
      (!activeModal && nextModal) ||
      (activeModal && !nextModal) ||
      (activeModal && nextModal && activeModal._id !== nextModal._id)
    ) {
      dispatch({ type: 'SET_ACTIVE_MODAL', payload: nextModal });
    }

    // Telemetry: Track queue length changes
    if (previousQueueLengthRef.current !== regularModals.length) {
      logEvent.mutate(
        {
          type: ModalEvents.MODAL_MANAGER_QUEUE_CHANGE,
          metadata: {
            previous_length: previousQueueLengthRef.current,
            new_length: regularModals.length,
            change: regularModals.length - previousQueueLengthRef.current,
            timestamp: Date.now(),
          },
        },
        {
          onError: () => {
            // Silently fail - telemetry should never impact user experience
          },
        }
      );
      previousQueueLengthRef.current = regularModals.length;
    }
  }, [
    modals.data,
    currentUser,
    counters.data,
    counters.isPending,
    tagToTrigger,
    isAdminPage,
    triggerModalByTag,
    banners,
    modalQueue,
    activeModal,
    logEvent,
    isStreaming,
    isModalOpen,
  ]);

  useEffect(() => {
    // Skip if 'whats-new' tag - this is exclusively handled by WhatsNewSliderModal
    if (tagToTrigger === 'whats-new') return;

    if (tagToTrigger && !isAdminPage) {
      const taggedModal = [...banners, ...modalQueue].find(modal => modal.tags?.includes(tagToTrigger));
      if (taggedModal && taggedModal._id) {
        if (taggedModal.isBanner) {
          dispatch({ type: 'MOVE_BANNER_TO_FRONT', payload: taggedModal._id });
        } else {
          dispatch({ type: 'SET_ACTIVE_MODAL', payload: taggedModal });
          dispatch({ type: 'SET_IS_MODAL_OPEN', payload: true });
        }
      }
    }
  }, [tagToTrigger, triggerCounter, banners, modalQueue, isAdminPage]);

  // Effect 2: Resume modal queue after What's New slider closes
  useEffect(() => {
    // When slider closes (tagToTrigger becomes null) and we had shown What's New, resume normal queue
    if (!tagToTrigger && whatsNewShown && modalQueue.length > 0) {
      dispatch({ type: 'SET_WHATS_NEW_SHOWN', payload: false });
      // hasTriggeredRef reset is handled in Effect 1 after confirming counters are updated
      dispatch({ type: 'SET_ACTIVE_MODAL', payload: modalQueue[0] || null });
    }
  }, [tagToTrigger, whatsNewShown, modalQueue]);

  useEffect(() => {
    if (!activeModal || activeModal.presignedUrl) return;

    const { imageUrl } = activeModal;

    if (imageUrl) {
      // Skip presigned URL fetching for cached external images (already public)
      if (imageUrl.includes('/proxied-images/')) {
        dispatch({
          type: 'UPDATE_ACTIVE_MODAL_PRESIGNED_URL',
          payload: {
            presignedUrl: imageUrl, // Use the public URL directly
            fetchedPresignedUrl: true,
          },
        });
        return;
      }

      const urlObj = new URL(imageUrl);
      const filePath = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;

      getPresignedUrl(
        { filePaths: [filePath], expiresIn: 3600 },
        {
          onSuccess: data => {
            const [presignedUrl] = data;

            dispatch({
              type: 'UPDATE_ACTIVE_MODAL_PRESIGNED_URL',
              payload: {
                presignedUrl,
                fetchedPresignedUrl: true,
              },
            });
          },
          onError: () => {
            dispatch({
              type: 'UPDATE_ACTIVE_MODAL_PRESIGNED_URL',
              payload: { fetchedPresignedUrl: true },
            });
          },
        }
      );
    }
  }, [activeModal, getPresignedUrl]);

  useEffect(() => {
    // Don't open GenericModal if slider is active or if conditions aren't met
    if (!modals.isPending && activeModal && !tagToTrigger && !isModalOpen && !whatsNewShown) {
      const timer = setTimeout(() => dispatch({ type: 'SET_IS_MODAL_OPEN', payload: true }), 3000);
      return () => clearTimeout(timer);
    }
  }, [modals.isPending, activeModal, tagToTrigger, isModalOpen, isAdminPage, whatsNewShown]);

  const renderBanners = useMemo(
    () => banners.map(banner => <BannerModal key={banner._id} banner={banner} onClose={handleCloseBanner} />),
    [banners, handleCloseBanner]
  );

  if (modals.isPending || (modalQueue.length === 0 && banners.length === 0)) {
    return null;
  }

  return (
    <>
      {renderBanners}
      {activeModal && tagToTrigger !== 'whats-new' && !activeModal.tags?.includes('whats-new') && (
        <GenericModal
          {...activeModal}
          hasPresignedUrl={true}
          isOpen={isModalOpen}
          onClose={handleCloseModal}
          onAgree={handleAgreeModal}
          isPreview={false}
        />
      )}
    </>
  );
};

export default React.memo(ModalManager);
