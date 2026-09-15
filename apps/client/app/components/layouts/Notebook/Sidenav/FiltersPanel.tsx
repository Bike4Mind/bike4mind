import { Box, Typography, Radio } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import EditIcon from '@mui/icons-material/Edit';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import NumbersIcon from '@mui/icons-material/Numbers';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';

export type NotebookTypeFilter = 'all' | 'notebooks' | 'projects' | 'agents';

interface FiltersPanelProps {
  typeOptions: { value: NotebookTypeFilter; label: string }[];
  typeFilter: NotebookTypeFilter;
  setTypeFilter: (value: NotebookTypeFilter) => void;
  showMessageCounts: boolean;
  setShowMessageCounts: (value: boolean) => void;
  onOpenBulkActions: () => void;
  onClose: () => void;
}

/**
 * Sidebar Filters popover panel: visibility (type) radios + message-counts toggle + the
 * bulk-actions entry. The anchor button, open/close state, the `filtersAnchorRef`, and the
 * bulk-actions popover stay in the parent; this component renders only the panel content shown
 * while it is open.
 */
export default function FiltersPanel({
  typeOptions,
  typeFilter,
  setTypeFilter,
  showMessageCounts,
  setShowMessageCounts,
  onOpenBulkActions,
  onClose,
}: FiltersPanelProps) {
  const { t } = useTranslation();

  return (
    <>
      <Box onClick={onClose} sx={{ position: 'fixed', inset: 0, zIndex: 10000 }} />
      <Box
        data-testid="sidenav-filters-panel"
        sx={theme => ({
          position: 'absolute',
          top: 'calc(100% + 8px)',
          right: 0,
          width: 'calc(var(--notebook-sidenav-width) - 20px)',
          zIndex: 10001,
          backgroundColor: theme.palette.background.surface,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: '12px',
          boxShadow: 'none',
          p: '16px 16px 12px 16px',
        })}
      >
        <Typography
          level="body-xs"
          sx={{ color: 'text.tertiary', fontSize: '12px', fontWeight: 400, letterSpacing: 0, mb: '12px' }}
        >
          {t('filter.visibility', 'VISIBILITY')}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px', mb: '16px' }}>
          {typeOptions.map(opt => {
            const selected = typeFilter === opt.value;
            return (
              <Box
                key={opt.value}
                data-testid={`sidenav-filter-${opt.value}`}
                onClick={() => setTypeFilter(opt.value)}
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
                    backgroundColor: selected
                      ? theme.palette.notebooklist.focusedBackground
                      : theme.palette.notebooklist.hoverBg,
                  },
                })}
              >
                <Radio
                  checked={selected}
                  color="success"
                  size="sm"
                  onChange={() => setTypeFilter(opt.value)}
                  slotProps={{ input: { 'aria-label': opt.label } }}
                  sx={{
                    '--Radio-size': '20px',
                    // Inner checked dot fixed to 12x12 (overrides Joy's size-relative dot).
                    '& .MuiRadio-icon': { width: '12px', height: '12px', borderRadius: '50%' },
                  }}
                />
                <Typography level="body-sm" sx={{ fontWeight: 400, color: 'text.primary' }}>
                  {opt.label}
                </Typography>
              </Box>
            );
          })}
        </Box>

        <Typography
          level="body-xs"
          sx={{ color: 'text.tertiary', fontSize: '12px', fontWeight: 400, letterSpacing: 0, mb: '12px' }}
        >
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
    </>
  );
}
