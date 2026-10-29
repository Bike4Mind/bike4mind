import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Box, Typography, Radio } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import EditIcon from '@mui/icons-material/Edit';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import NumbersIcon from '@mui/icons-material/Numbers';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import type { NotebookContentFilter, NotebookOriginFilter } from './sidenavFilters';

export type NotebookTypeFilter = 'all' | 'notebooks' | 'projects' | 'agents';

interface FiltersPanelProps {
  typeOptions: { value: NotebookTypeFilter; label: string }[];
  typeFilter: NotebookTypeFilter;
  setTypeFilter: (value: NotebookTypeFilter) => void;
  contentFilter: NotebookContentFilter;
  setContentFilter: (value: NotebookContentFilter) => void;
  originFilter: NotebookOriginFilter;
  setOriginFilter: (value: NotebookOriginFilter) => void;
  showMessageCounts: boolean;
  setShowMessageCounts: (value: boolean) => void;
  onOpenBulkActions: () => void;
  onClose: () => void;
  /** The Filters button's wrapper: the panel opens centred under it. */
  anchorRef: RefObject<HTMLElement | null>;
}

const sectionTitleSx = { color: 'text.tertiary', fontSize: '12px', fontWeight: 400, letterSpacing: 0, mb: '12px' };

function FilterRadioRow({
  testId,
  label,
  selected,
  onSelect,
}: {
  testId: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Box
      data-testid={testId}
      onClick={onSelect}
      sx={theme => ({
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        px: 1,
        height: '36px',
        borderRadius: '8px',
        cursor: 'pointer',
        backgroundColor: selected ? theme.palette.notebooklist.focusedBackground : 'transparent',
        transition: 'background 0.15s',
        '&:hover': {
          backgroundColor: selected ? theme.palette.notebooklist.focusedBackground : theme.palette.notebooklist.hoverBg,
        },
      })}
    >
      <Radio
        checked={selected}
        color="success"
        size="sm"
        onChange={onSelect}
        slotProps={{ input: { 'aria-label': label } }}
        sx={{
          '--Radio-size': '20px',
          // Inner checked dot fixed to 12x12 (overrides Joy's size-relative dot).
          '& .MuiRadio-icon': { width: '12px', height: '12px', borderRadius: '50%' },
        }}
      />
      <Typography level="body-sm" sx={{ fontWeight: 400, color: 'text.primary' }}>
        {label}
      </Typography>
    </Box>
  );
}

/**
 * Sidebar Filters popover panel: visibility (type), content and origin radios + message-counts
 * toggle + the bulk-actions entry. Content and origin map to server-side list filters
 * (sidenavFilters.ts). The anchor button, open/close state, the `filtersAnchorRef`, and the
 * bulk-actions popover stay in the parent; this component renders only the panel content shown
 * while it is open. Portaled to <body> and centred under the button, only as wide as its rows, so the
 * sidebar's scroll region neither clips it nor stretches it to the sidebar's width.
 */
export default function FiltersPanel({
  typeOptions,
  typeFilter,
  setTypeFilter,
  contentFilter,
  setContentFilter,
  originFilter,
  setOriginFilter,
  showMessageCounts,
  setShowMessageCounts,
  onOpenBulkActions,
  onClose,
  anchorRef,
}: FiltersPanelProps) {
  const { t } = useTranslation();
  // Placed once on open, before paint: the full-screen backdrop below takes the pointer, so nothing
  // scrolls under it while it is up.
  const [place, setPlace] = useState({ top: 0, left: 0 });
  // On a short viewport the panel scrolls; a fade at its foot says there is more below until the end.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = () => {
    const el = scrollRef.current;
    setMoreBelow(!!el && el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  };
  useLayoutEffect(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (anchor) setPlace({ top: anchor.bottom + 8, left: anchor.left + anchor.width / 2 });
  }, [anchorRef]);
  // After the placement lands, so the scroll check reads the panel at its final height.
  useLayoutEffect(measure, [place]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const contentOptions: { value: NotebookContentFilter; testId: string; label: string }[] = [
    { value: 'all', testId: 'sidenav-filter-content-all', label: t('filter.content.all', 'All') },
    { value: 'chats', testId: 'sidenav-filter-content-chats', label: t('filter.content.chats', 'Chats') },
    { value: 'images', testId: 'sidenav-filter-content-images', label: t('filter.content.images', 'Images') },
  ];
  const originOptions: { value: NotebookOriginFilter; testId: string; label: string }[] = [
    { value: 'all', testId: 'sidenav-filter-origin-all', label: t('filter.origin.all', 'All') },
    { value: 'hideApi', testId: 'sidenav-filter-origin-hide-api', label: t('filter.origin.hideApi', 'Hide API') },
    { value: 'onlyApi', testId: 'sidenav-filter-origin-api', label: t('filter.origin.onlyApi', 'Only API') },
  ];

  return createPortal(
    <>
      <Box onClick={onClose} sx={{ position: 'fixed', inset: 0, zIndex: 10000 }} />
      <Box
        data-testid="sidenav-filters-panel"
        sx={theme => ({
          position: 'fixed',
          top: place.top,
          left: place.left,
          transform: 'translateX(-50%)',
          width: 'max-content',
          zIndex: 10001,
          backgroundColor: theme.palette.background.surface,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: '12px',
          boxShadow: 'none',
          overflow: 'hidden',
          display: 'flex',
          // Five sections can outgrow a short viewport; scroll inside the panel instead of clipping.
          maxHeight: `calc(100vh - ${place.top + 16}px)`,
        })}
      >
        <Box
          ref={scrollRef}
          data-testid="sidenav-filters-scroll"
          onScroll={measure}
          sx={{ ...scrollbarStyles, overflowY: 'auto', p: '16px 16px 12px 16px' }}
        >
          <Typography level="body-xs" sx={sectionTitleSx}>
            {t('filter.visibility', 'VISIBILITY')}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', mb: '16px' }}>
            {typeOptions.map(opt => (
              <FilterRadioRow
                key={opt.value}
                testId={`sidenav-filter-${opt.value}`}
                label={opt.label}
                selected={typeFilter === opt.value}
                onSelect={() => setTypeFilter(opt.value)}
              />
            ))}
          </Box>

          <Typography level="body-xs" sx={sectionTitleSx}>
            {t('filter.content.title', 'CONTENT')}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', mb: '16px' }}>
            {contentOptions.map(opt => (
              <FilterRadioRow
                key={opt.value}
                testId={opt.testId}
                label={opt.label}
                selected={contentFilter === opt.value}
                onSelect={() => setContentFilter(opt.value)}
              />
            ))}
          </Box>

          <Typography level="body-xs" sx={sectionTitleSx}>
            {t('filter.origin.title', 'ORIGIN')}
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', mb: '16px' }}>
            {originOptions.map(opt => (
              <FilterRadioRow
                key={opt.value}
                testId={opt.testId}
                label={opt.label}
                selected={originFilter === opt.value}
                onSelect={() => setOriginFilter(opt.value)}
              />
            ))}
          </Box>

          <Typography level="body-xs" sx={sectionTitleSx}>
            {t('filter.notebooksActions', 'NOTEBOOKS ACTIONS')}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', px: 1, py: '8px' }}>
            <NumbersIcon sx={{ fontSize: '18px', color: 'text.tertiary' }} />
            <Typography level="body-sm" sx={{ flex: 1, fontWeight: 400, color: 'text.primary' }}>
              {t('sidenav.messageCounts', 'Message counts')}
            </Typography>
            <SquareSlideToggle
              checked={showMessageCounts}
              onChange={() => setShowMessageCounts(!showMessageCounts)}
              width={40}
              height={24}
              data-testid="sidenav-message-counts-switch"
            />
          </Box>
          <Box
            data-testid="sidenav-bulk-actions"
            onClick={onOpenBulkActions}
            sx={theme => ({
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              px: 1,
              py: '8px',
              borderRadius: '8px',
              cursor: 'pointer',
              transition: 'background 0.15s',
              '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
            })}
          >
            <EditIcon sx={{ fontSize: '18px', color: 'text.tertiary' }} />
            <Typography level="body-sm" sx={{ flex: 1, fontWeight: 400, color: 'text.primary' }}>
              {t('sidenav.bulkActions', 'Notebooks bulk actions')}
            </Typography>
            <KeyboardArrowRightIcon sx={{ fontSize: '18px', color: 'text.primary' }} />
          </Box>
        </Box>
        <Box
          data-testid="sidenav-filters-more"
          aria-hidden
          sx={theme => ({
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '32px',
            pointerEvents: 'none',
            background: `linear-gradient(to bottom, transparent, ${theme.palette.background.surface})`,
            opacity: moreBelow ? 1 : 0,
            transition: 'opacity 0.15s',
          })}
        />
      </Box>
    </>,
    document.body
  );
}
