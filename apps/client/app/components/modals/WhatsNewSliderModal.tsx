import { useUser } from '@client/app/contexts/UserContext';
import { useGetModals } from '@client/app/hooks/data/modals';
import { useGetUserActivityCounters } from '@client/app/hooks/data/user';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { IModalDocument, ModalEvents, IUserActivityCounterDocument } from '@bike4mind/common';
import { filterModals, modalStorage } from './modalHelpers';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import Modal from '@mui/joy/Modal';
import { Box, Typography, IconButton, Sheet, CircularProgress, Button, ModalDialog } from '@mui/joy';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import CloseIcon from '@mui/icons-material/Close';
import { useMediaQuery } from '@mui/system';
import { useGetPresignedUrl } from '@client/app/hooks/data/fabFiles';
import { useModalTrigger } from '@client/app/contexts/ModalTriggerContext';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { brandAlpha } from '@client/app/utils/themes/colors';
import { DISPLAY_DATE_REGEX } from '@client/app/utils/dateUtils';

/** Parse subtitle field into display date and subtitle (admin stores "DATE" or "DATE · SUBTITLE" or "SUBTITLE") */
function parseSubtitleForDisplay(subtitle: string | null | undefined): { displayDate: string; subtitle: string } {
  if (!subtitle?.trim()) return { displayDate: '', subtitle: '' };
  const sep = ' · ';
  if (subtitle.includes(sep)) {
    const [first, ...rest] = subtitle.split(sep);
    const datePart = first?.trim() ?? '';
    const subtitlePart = rest.join(sep).trim();
    return { displayDate: datePart, subtitle: subtitlePart };
  }
  if (DISPLAY_DATE_REGEX.test(subtitle.trim())) {
    return { displayDate: subtitle.trim(), subtitle: '' };
  }
  return { displayDate: '', subtitle: subtitle.trim() };
}

const navButtonSx = {
  border: '1px solid',
  borderColor: 'border.solid',
  borderRadius: '6px',
  width: { xs: '32px', sm: '60px' },
  height: { xs: '32px', sm: '32px' },
  minWidth: { xs: '32px', sm: '60px' },
  minHeight: '32px',
  maxHeight: { xs: '32px', sm: 'none' },
  padding: 0,
  '--IconButton-size': { xs: '32px' },
  '&:hover': {
    backgroundColor: 'neutral.outlinedHoverBg',
    borderColor: 'neutral.outlinedHoverBorder',
  },
} as const;

interface WhatsNewSliderModalProps {
  tagToTrigger: string;
}

const WhatsNewSliderModal: React.FC<WhatsNewSliderModalProps> = ({ tagToTrigger }) => {
  const { currentUser } = useUser();
  const modals = useGetModals();
  const counters = useGetUserActivityCounters(currentUser?.id);
  const logEvent = useLogEvent();
  const queryClient = useQueryClient();
  const [activeModalList, setActiveModalList] = useState<IModalDocument[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [showNoNewsModal, setShowNoNewsModal] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [urlImages, setUrlImages] = useState<Record<string, string> | null>({});

  const isMobile = useMediaQuery('(max-width:768px)');
  const { mutate: getPresignedUrls, isPending } = useGetPresignedUrl();
  const { resetTrigger } = useModalTrigger();

  // Refs for accessibility
  const modalRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElement = useRef<HTMLElement | null>(null);

  // Refs for telemetry
  const modalOpenTime = useRef<number | null>(null);
  // eslint-disable-next-line react-hooks/purity -- Date.now() initializes a telemetry ref; value is never rendered, only read in event handlers
  const slideStartTime = useRef<number>(Date.now());
  const slideViewTimes = useRef<Map<number, number>>(new Map());
  // eslint-disable-next-line react-hooks/purity -- Date.now() initializes a render-time telemetry ref; never rendered, only used for duration calculations in handlers
  const renderStartTime = useRef<number>(Date.now());
  const presignedUrlStartTime = useRef<number | null>(null);

  useEffect(() => {
    let isMounted = true; // Track if component is mounted

    if (activeModalList.length === 0) {
      setUrlImages({});
      return;
    }

    const pathFiles = {} as Record<string, string>;
    const publicImages = {} as Record<string, string>;

    for (const modal of activeModalList) {
      const { _id: modalId, imageUrl } = modal;

      if (modalId && imageUrl) {
        // Skip presigned URL fetching for cached external images (already public)
        if (imageUrl.includes('/proxied-images/')) {
          publicImages[modalId] = imageUrl;
          continue;
        }

        const urlObj = new URL(imageUrl);
        const filePath = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;

        pathFiles[modalId] = filePath;
      }
    }

    // Set public images immediately
    if (Object.keys(publicImages).length > 0) {
      if (isMounted) setUrlImages(prev => ({ ...prev, ...publicImages }));
    }

    if (Object.keys(pathFiles).length === 0) {
      // If no images need presigned URLs, we're done
      if (Object.keys(publicImages).length === 0) {
        if (isMounted) setUrlImages({});
      }
      return;
    }

    // Track presigned URL fetch performance
    presignedUrlStartTime.current = Date.now();

    getPresignedUrls(
      { filePaths: Object.values(pathFiles), expiresIn: 3600 },
      {
        onSuccess: data => {
          if (!isMounted) return; // Prevent setState on unmounted component

          // Telemetry: Log presigned URL load time (silent failure)
          if (presignedUrlStartTime.current) {
            const loadDuration = Date.now() - presignedUrlStartTime.current;
            logEvent.mutate(
              {
                type: ModalEvents.WHATS_NEW_PERFORMANCE,
                metadata: {
                  component: 'WhatsNewSliderModal',
                  metric: 'presigned_url_load_time',
                  duration: loadDuration,
                  image_count: Object.keys(pathFiles).length,
                },
              },
              {
                onError: () => {
                  // Silently fail - telemetry should never impact user experience
                },
              }
            );
          }

          const pathFilesImages = {} as Record<string, string>;

          Object.entries(pathFiles).forEach(([modalId, filePath]) => {
            data.forEach(url => {
              if (url.includes(filePath)) {
                pathFilesImages[modalId] = url;
              }
            });
          });

          setUrlImages(prev => ({ ...prev, ...pathFilesImages }));
        },
        onError: () => {
          if (!isMounted) return; // Prevent setState on unmounted component

          // Telemetry: Log presigned URL fetch error (silent failure)
          if (presignedUrlStartTime.current) {
            const loadDuration = Date.now() - presignedUrlStartTime.current;
            logEvent.mutate(
              {
                type: ModalEvents.WHATS_NEW_PERFORMANCE,
                metadata: {
                  component: 'WhatsNewSliderModal',
                  metric: 'presigned_url_load_error',
                  duration: loadDuration,
                  image_count: Object.keys(pathFiles).length,
                },
              },
              {
                onError: () => {
                  // Silently fail - telemetry should never impact user experience
                },
              }
            );
          }

          // Keep the public images even if presigned URL fetching fails
          setUrlImages(prev => ({ ...publicImages }));
        },
      }
    );

    // Cleanup function
    return () => {
      isMounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModalList, tagToTrigger]);
  // getPresignedUrls and logEvent are stable mutation functions and should NOT be in deps
  // Including them causes infinite loops when mutations fail (mutation ref changes -> effect reruns -> fails again -> loop)

  const activeModals = useMemo(() => {
    // Wait for all data to load before filtering modals
    // Check both isPending AND that counters.data exists to prevent timing issues
    if (!modals.data || !currentUser || counters.isPending || !counters.data) return [];

    // Pass actual counter data to filterModals for proper threshold checking
    const whatsNewModal = filterModals(modals.data, currentUser, counters.data ?? [], [tagToTrigger]);
    // Type assertion is safe: filterModals() returns IModal[] but runtime data
    // from MongoDB includes createdAt/updatedAt fields (IModalDocument).
    // This allows us to sort by createdAt which exists on all persisted modals.
    return (whatsNewModal as IModalDocument[])
      .filter(modal => !modal.isBanner)
      .sort((a, b) => {
        // Primary sort: createdAt descending (newest first)
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;

        // Handle invalid dates (NaN)
        const aDate = isNaN(aTime) ? 0 : aTime;
        const bDate = isNaN(bTime) ? 0 : bTime;

        // If dates differ, sort by date
        if (bDate !== aDate) {
          return bDate - aDate;
        }

        // Secondary sort: priority descending (higher priority first)
        const priorityDiff = (b.priority || 0) - (a.priority || 0);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        // Tertiary sort: _id for stable ordering (prevents random reordering on re-renders)
        return (b._id || '').localeCompare(a._id || '');
      });
  }, [modals.data, currentUser, counters.data, counters.isPending, tagToTrigger]);

  useEffect(() => {
    // Only proceed if all data is fully loaded (prevent opening before filtering completes)
    if (counters.isPending || !counters.data || !modals.data || !currentUser) return;

    if (activeModals.length > 0) {
      setActiveModalList(activeModals);
      setIsOpen(true);
    } else {
      // Only show "no news" modal after confirming data is fully loaded
      setShowNoNewsModal(true);
    }
  }, [activeModals, counters.isPending, counters.data, modals.data, currentUser]);

  // Telemetry: Track modal opening
  useEffect(() => {
    if (isOpen && !modalOpenTime.current) {
      modalOpenTime.current = Date.now();
      slideStartTime.current = Date.now();

      // Track render performance
      const renderDuration = Date.now() - renderStartTime.current;

      // Determine source (auto-trigger vs manual)
      const source = tagToTrigger === 'whats-new' ? 'manual' : 'auto';

      logEvent.mutate(
        {
          type: ModalEvents.WHATS_NEW_OPENED,
          metadata: {
            source,
            modal_count: activeModalList.length,
            render_duration: renderDuration,
            timestamp: modalOpenTime.current,
          },
        },
        {
          onError: () => {
            // Silently fail - telemetry should never impact user experience
          },
        }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, tagToTrigger, activeModalList.length]);
  // logEvent excluded from deps - useMutation returns a new ref on every render;
  // including it causes this effect to re-fire after each mutation, creating an infinite request loop.

  // Telemetry: Track slide progression
  useEffect(() => {
    if (!isOpen) return;

    const now = Date.now();
    const previousSlide = currentSlide > 0 ? currentSlide - 1 : null;

    // Calculate time spent on previous slide
    if (slideStartTime.current && previousSlide !== null) {
      const duration = now - slideStartTime.current;
      slideViewTimes.current.set(previousSlide, duration);

      logEvent.mutate(
        {
          type: ModalEvents.WHATS_NEW_SLIDE_CHANGED,
          metadata: {
            from_slide: previousSlide,
            to_slide: currentSlide,
            duration_on_previous: duration,
            total_slides: activeModalList.length,
            modal_id: activeModalList[currentSlide]?._id,
          },
        },
        {
          onError: () => {
            // Silently fail - telemetry should never impact user experience
          },
        }
      );
    }

    // Reset slide start time for new slide
    slideStartTime.current = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSlide, isOpen, activeModalList]);
  // logEvent excluded from deps - useMutation returns a new ref on every render;
  // including it causes this effect to re-fire after each slide change mutation, flooding the analytics endpoint.

  const handleClose = useCallback(() => {
    // Telemetry: Track modal closing
    if (modalOpenTime.current) {
      const totalDuration = Date.now() - modalOpenTime.current;
      const currentSlideDuration = Date.now() - slideStartTime.current;

      // Record time spent on current slide
      slideViewTimes.current.set(currentSlide, currentSlideDuration);

      // Convert slide view times to array for metadata
      const slideViewData = Array.from(slideViewTimes.current.entries()).map(([slide, duration]) => ({
        slide,
        duration,
        modal_id: activeModalList[slide]?._id,
      }));

      logEvent.mutate(
        {
          type: ModalEvents.WHATS_NEW_CLOSED,
          metadata: {
            total_duration: totalDuration,
            final_slide: currentSlide,
            total_slides: activeModalList.length,
            slides_viewed: slideViewTimes.current.size,
            slide_view_data: slideViewData,
            timestamp: Date.now(),
          },
        },
        {
          onError: () => {
            // Silently fail - telemetry should never impact user experience
          },
        }
      );

      // Reset telemetry refs
      modalOpenTime.current = null;
      slideViewTimes.current.clear();
    }

    setIsOpen(false);

    // Optimistically update counter cache to prevent race conditions
    // so filterModals sees updated counters immediately
    const queryKey = ['users', currentUser?.id, 'activities'];
    const currentCounters = queryClient.getQueryData<IUserActivityCounterDocument[]>(queryKey) || [];

    activeModalList.forEach(modal => {
      if (modal._id) {
        // Find existing counter for this modal
        const existingCounter = currentCounters.find(c => c.action === 'Modal Viewed' && c.tags?.includes(modal._id!));

        if (existingCounter) {
          // Update existing counter
          existingCounter.count += 1;
          existingCounter.updatedAt = new Date();
        } else {
          // Create new counter entry
          const tempId = `temp-${modal._id}-${Date.now()}`;
          currentCounters.push({
            _id: tempId,
            id: tempId,
            userId: currentUser?.id || '',
            action: 'Modal Viewed',
            count: 1,
            tags: [modal._id!],
            createdAt: new Date(),
            updatedAt: new Date(),
          } as IUserActivityCounterDocument);
        }
      }

      // Mark modal as seen in localStorage (local cooldown tracking)
      if (modal._id) {
        modalStorage.setLastShownTime(modal._id);
      }
    });

    // Update cache with optimistic data
    queryClient.setQueryData(queryKey, currentCounters);

    // Log view events for all modals in the slider to persist to backend
    // Batch invalidation: only invalidate after all logging completes
    // log for every modal with an id - checkModalThresholds (incl. the implicit-firstTime
    // default for modals without numberOfViews configured) relies on this counter to hide the
    // modal on subsequent loads.
    const modalsToLog = activeModalList.filter(modal => modal._id);
    let completedCount = 0;

    if (modalsToLog.length === 0) {
      // No modals to log, reset immediately
      resetTrigger();
      return;
    }

    modalsToLog.forEach(modal => {
      logEvent.mutate(
        { type: ModalEvents.VIEW_MODAL, metadata: { id: modal._id } },
        {
          onSuccess: () => {
            completedCount++;
            // Only invalidate after all mutations complete
            if (completedCount === modalsToLog.length) {
              queryClient.invalidateQueries({ queryKey: ['users', currentUser?.id, 'activities'] });
            }
          },
          onError: () => {
            completedCount++;
            // Still invalidate even if some failed, to refresh cache
            if (completedCount === modalsToLog.length) {
              queryClient.invalidateQueries({ queryKey: ['users', currentUser?.id, 'activities'] });
            }
          },
        }
      );
    });

    resetTrigger();
  }, [activeModalList, logEvent, queryClient, currentUser?.id, resetTrigger, currentSlide]);

  const goToNextSlide = useCallback(() => {
    const slideNumber = currentSlide === activeModalList.length - 1 ? 0 : currentSlide + 1;
    setCurrentSlide(slideNumber);
  }, [currentSlide, activeModalList.length]);

  const goToPrevSlide = useCallback(() => {
    const slideNumber = currentSlide > 0 ? currentSlide - 1 : activeModalList.length - 1;
    setCurrentSlide(slideNumber);
  }, [currentSlide, activeModalList.length]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          if (activeModalList.length > 1) goToPrevSlide();
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (activeModalList.length > 1) goToNextSlide();
          break;
        case 'Escape':
          e.preventDefault();
          handleClose();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, activeModalList.length, goToPrevSlide, goToNextSlide, handleClose]);

  // Focus management
  useEffect(() => {
    if (isOpen) {
      // Save currently focused element
      previouslyFocusedElement.current = document.activeElement as HTMLElement;

      // Focus modal after a brief delay to ensure it's rendered
      setTimeout(() => {
        modalRef.current?.focus();
      }, 100);
    } else if (previouslyFocusedElement.current) {
      // Restore focus when modal closes
      previouslyFocusedElement.current.focus();
      previouslyFocusedElement.current = null;
    }
  }, [isOpen]);

  if (activeModalList.length === 0 && !showNoNewsModal) return null;

  // Show "No News" modal
  if (showNoNewsModal) {
    const handleNoNewsClose = () => {
      setShowNoNewsModal(false);
      resetTrigger();
    };

    return (
      <Modal
        open={showNoNewsModal}
        onClose={handleNoNewsClose}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ModalDialog
          variant="outlined"
          sx={{
            maxWidth: 500,
            borderRadius: 'md',
            p: 3,
            boxShadow: 'lg',
          }}
        >
          <Typography level="h2" sx={{ mb: 2 }}>
            No News is Good News!
          </Typography>
          <Typography level="body-md" sx={{ mb: 3 }}>
            But seriously, there&apos;s nothing new to show right now. Check back later for updates!
          </Typography>
          <Button
            variant="solid"
            color="primary"
            onClick={handleNoNewsClose}
            data-testid="no-news-ok-btn"
            sx={{ alignSelf: 'flex-end' }}
          >
            OK
          </Button>
        </ModalDialog>
      </Modal>
    );
  }

  const currentModal = activeModalList[currentSlide];
  const currentTitle = currentModal.title || '';
  const currentImageUrl = urlImages?.[currentModal._id || ''];
  const { displayDate, subtitle: subtitleText } = parseSubtitleForDisplay(currentModal.subtitle);

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Sheet
        ref={modalRef}
        tabIndex={-1}
        aria-labelledby="whats-new-modal-title"
        aria-modal="true"
        role="dialog"
        variant="outlined"
        sx={{
          width: '100%',
          maxWidth: isMobile ? '100%' : '940px',
          height: isMobile ? '100%' : '600px',
          maxHeight: isMobile ? 'calc(100vh - 32px)' : '600px',
          minHeight: 0,
          borderRadius: '12px',
          overflow: 'hidden',
          boxShadow: 'lg',
          display: 'flex',
          flexDirection: 'column',
          m: isMobile ? '16px' : 'auto',
          position: 'relative',
          '&:focus': {
            outline: 'none',
          },
        }}
      >
        {/* Screen reader announcements */}
        <Box
          role="status"
          aria-live="polite"
          aria-atomic="true"
          sx={{
            position: 'absolute',
            left: '-10000px',
            width: '1px',
            height: '1px',
            overflow: 'hidden',
          }}
        >
          Showing announcement {currentSlide + 1} of {activeModalList.length}: {currentModal.title}
        </Box>
        <IconButton
          onClick={handleClose}
          aria-label="Close What's New announcements"
          sx={theme => ({
            position: 'absolute',
            right: '10px',
            top: '10px',
            zIndex: 1,
            '--Icon-color': theme.palette.text.tertiary,
            '&:hover': {
              backgroundColor: 'transparent',
              '--Icon-color': theme.palette.text.primary,
            },
          })}
          data-testid="whats-new-slider-modal-close-btn-icon-container"
        >
          <CloseIcon data-testid="whats-new-slider-modal-close-button-icon" />
        </IconButton>

        <Box
          sx={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            flex: 1,
            minHeight: 0,
            position: 'relative',
            overflow: 'hidden',
            justifyContent: 'space-between',
            columnGap: isMobile ? 0 : '60px',
            p: isMobile ? '16px' : '24px',
          }}
        >
          {/* Image Section - Top on mobile */}
          {isMobile && currentModal.imageUrl && (
            <Box
              sx={{
                flexShrink: 0,
                width: '100%',
                height: '35vh',
                minHeight: '200px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                backgroundColor: 'neutral.500',
                borderRadius: '12px 12px 0 0',
              }}
            >
              {isPending
                ? currentModal.imageUrl && (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        height: '100%',
                      }}
                    >
                      <CircularProgress size="lg" />
                    </Box>
                  )
                : currentImageUrl && (
                    <Box
                      component="img"
                      src={currentImageUrl}
                      alt={currentTitle}
                      sx={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                      }}
                    />
                  )}
            </Box>
          )}

          {/* Content Section */}
          <Box
            sx={{
              width: isMobile ? '100%' : currentModal.imageUrl ? '400px' : '100%',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                flex: 1,
                height: 0,
                minHeight: 0,
                width: '100%',
                overflow: 'auto',
                ...scrollbarStyles,
                '&::-webkit-scrollbar-button:start:decrement': {
                  display: 'block',
                  height: '44px',
                  backgroundColor: 'transparent',
                },
              }}
            >
              <Box
                sx={theme => ({
                  display: 'block',
                  '& .markdown-viewer-container': {
                    overflow: 'visible',
                    p: 0,
                    // Custom header styles for #, ##, ###, #### - What's New modal only
                    '& h1': {
                      fontSize: { xs: '24px', sm: '28px' },
                      fontWeight: 600,
                      color: 'var(--joy-palette-text-primary)',
                      marginBottom: { xs: '10px', sm: '12px' },
                    },
                    '& h2': {
                      fontSize: { xs: '20px', sm: '24px' },
                      fontWeight: 500,
                      color: 'var(--joy-palette-text-primary)',
                      marginBottom: { xs: '10px', sm: '12px' },
                    },
                    '& h3': {
                      fontSize: { xs: '18px', sm: '20px' },
                      fontWeight: 500,
                      color: 'var(--joy-palette-text-primary)',
                      marginBottom: { xs: '10px', sm: '12px' },
                    },
                    '& h4': {
                      fontSize: { xs: '16px', sm: '18px' },
                      fontWeight: 500,
                      color: 'var(--joy-palette-text-primary)',
                      marginBottom: { xs: '10px', sm: '12px' },
                    },
                    // Body text and lists
                    '& p': {
                      marginBottom: '24px',
                      marginTop: 0,
                      color: 'var(--joy-palette-text-secondary)',
                    },
                    '& ul': {
                      marginBottom: '24px',
                      marginTop: 0,
                      paddingLeft: '32px',
                      color: 'var(--joy-palette-text-secondary)',
                    },
                    '& ol': {
                      marginBottom: '24px',
                      marginTop: 0,
                      paddingLeft: '32px',
                      color: 'var(--joy-palette-text-secondary)',
                    },
                    '& ul + ul, & ul + ol, & ol + ul, & ol + ol': {
                      marginTop: '-16px',
                    },
                    '& li > ul, & li > ol': {
                      marginBottom: '8px',
                    },
                    '& li > ul > li:first-child, & li > ol > li:first-child': {
                      marginTop: '8px',
                    },
                    '& li:last-child > ul, & li:last-child > ol': {
                      marginBottom: '24px',
                    },
                    '& li': {
                      marginTop: 0,
                      marginBottom: '8px',
                    },
                    '& strong': {
                      color: 'var(--joy-palette-text-primary)',
                    },
                    '& hr': {
                      marginTop: 0,
                      marginBottom: '24px',
                      border: 'none',
                      height: '2px',
                      backgroundColor: theme.palette.text.primary,
                      opacity: 0.3,
                    },
                  },
                })}
              >
                {displayDate && (
                  <Typography
                    level="body-md"
                    sx={{
                      mb: 0.5,
                      fontSize: '16px',
                      color: 'text.tertiary',
                    }}
                  >
                    {displayDate}
                  </Typography>
                )}
                <Typography
                  id="whats-new-modal-title"
                  level="h2"
                  sx={{
                    mb: subtitleText ? 1 : 3,
                    fontSize: '24px',
                    fontWeight: 500,
                    color: 'primary.500',
                    pr: { xs: '32px', sm: 0 },
                  }}
                >
                  {currentModal.title}
                </Typography>
                {subtitleText && (
                  <Typography
                    level="body-lg"
                    sx={{
                      mb: 3,
                      fontSize: '16px',
                      color: 'text.tertiary',
                    }}
                  >
                    {subtitleText}
                  </Typography>
                )}
                <MarkdownViewer content={currentModal.description || ''} />
              </Box>
            </Box>

            {/* Navigation buttons and counter */}
            <Box
              sx={{
                display: 'flex',
                gap: 1,
                alignItems: 'center',
                justifyContent: 'space-between',
                pt: '20px',
                flex: '0 0 auto',
              }}
            >
              <Box sx={{ display: 'flex', gap: 1 }}>
                <IconButton
                  variant="outlined"
                  color="neutral"
                  onClick={goToPrevSlide}
                  aria-label="Previous announcement"
                  disabled={activeModalList.length === 1}
                  sx={navButtonSx}
                >
                  <KeyboardArrowLeftIcon sx={{ fontSize: { xs: 18, sm: 20 } }} />
                </IconButton>

                <IconButton
                  variant="outlined"
                  color="neutral"
                  onClick={goToNextSlide}
                  aria-label="Next announcement"
                  disabled={activeModalList.length === 1}
                  sx={navButtonSx}
                >
                  <KeyboardArrowRightIcon sx={{ fontSize: { xs: 18, sm: 20 } }} />
                </IconButton>
              </Box>
              <Typography
                level="body-sm"
                component="span"
                data-testid="whats-new-slide-counter"
                sx={theme => ({
                  color: 'text.primary',
                  bgcolor: theme.palette.mode === 'light' ? brandAlpha[100][30] : brandAlpha[100][12],
                  px: '12px',
                  height: '28px',
                  display: 'flex',
                  alignItems: 'center',
                  borderRadius: '6px',
                  fontWeight: 500,
                })}
              >
                {currentSlide + 1} of {activeModalList.length}
              </Typography>
            </Box>
          </Box>

          {/* Desktop Image Section - Right side */}
          {!isMobile && currentModal.imageUrl && (
            <Box
              sx={{
                width: '400px',
                height: '400px',
                display: 'flex',
                alignItems: 'center',
                position: 'relative',
              }}
            >
              {isPending
                ? currentModal.imageUrl && (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        height: '100%',
                      }}
                    >
                      <CircularProgress size="lg" />
                    </Box>
                  )
                : currentImageUrl && (
                    <Box
                      component="img"
                      src={currentImageUrl}
                      alt={currentTitle}
                      sx={{
                        width: '100%',
                        height: '100%',
                        borderRadius: '12px',
                        objectFit: 'contain',
                      }}
                    />
                  )}
            </Box>
          )}
        </Box>
      </Sheet>
    </Modal>
  );
};

export default WhatsNewSliderModal;
