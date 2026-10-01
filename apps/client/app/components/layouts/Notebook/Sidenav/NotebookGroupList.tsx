import { Box, Typography } from '@mui/joy';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ApiIcon from '@mui/icons-material/Api';
import { ISessionDocument, ISessionFavoriteItem } from '@bike4mind/common';
import { getDateLabel } from '@client/app/utils/dateUtils';
import { compareDateGroupKeys, groupItemsByDate } from './dateGrouping';
import NotebookRow from './NotebookRow';
import { collapseApiItems } from './apiGrouping';
import { useApiGroupExpansion } from './useApiGroupExpansion';
import type { CombinedItem } from './types';

interface NotebookGroupListProps {
  items: CombinedItem[];
  /** Favorites are rendered separately above this list and excluded here (matched by id). */
  favoriteItems: { id: string }[];
  isEditMode: boolean;
  selectedItems: Set<string>;
  favoriteSessions?: ISessionFavoriteItem[];
  showMessageCount: boolean;
  /**
   * Fold each date bucket's API-created notebooks into one expandable "API - N notebooks" row
   * (apiGrouping.ts). Off in bulk-edit mode regardless, so every row stays checkable.
   */
  groupApiNotebooks?: boolean;
  /** Force all session rows unselected (e.g. while a dedicated project screen is open). */
  suppressActive?: boolean;
  /** Id of the agent whose dedicated screen is open, so its row highlights. */
  activeAgentId?: string | null;
  onNavigate: (path: string) => void;
  onNotebookClick: (session: ISessionDocument) => void;
  onToggle: (id: string) => void;
}

/**
 * The non-favorite notebook list, grouped by date and sorted (Today/Yesterday/Previous 7/30,
 * then months most-recent-first). Grouping/sorting is memoized on the inputs that affect it;
 * the rows are `React.memo`'d so only changed rows re-render.
 */
export default function NotebookGroupList({
  items,
  favoriteItems,
  isEditMode,
  selectedItems,
  favoriteSessions,
  showMessageCount,
  groupApiNotebooks = true,
  suppressActive,
  activeAgentId,
  onNavigate,
  onNotebookClick,
  onToggle,
}: NotebookGroupListProps) {
  const { t } = useTranslation();
  const expandedBuckets = useApiGroupExpansion(s => s.expanded);
  const toggleBucket = useApiGroupExpansion(s => s.toggle);
  const shouldGroup = groupApiNotebooks && !isEditMode;
  const grouped = useMemo(() => {
    if (!items.length) return null;

    // Filter out favorites from regular list
    const nonFavoriteItems = items.filter(d => !favoriteItems.some(s => s.id === d.id));

    // Group sessions by date (chronological order)
    const groupSessions = groupItemsByDate(nonFavoriteItems, s => getDateLabel(s.lastUpdated));

    Object.keys(groupSessions).forEach(key => {
      groupSessions[key] = groupSessions[key].sort(
        (a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
      );
    });

    // Sort the group keys in chronological order
    const sortedGroupKeys = Object.keys(groupSessions).sort(compareDateGroupKeys);

    return { groupSessions, sortedGroupKeys };
  }, [items, favoriteItems]);

  if (!grouped) return null;

  const renderRow = (d: CombinedItem) => (
    <Box
      key={d.id}
      data-testid="notebook-list-item"
      sx={{ display: 'flex', alignItems: 'center', position: 'relative' }}
    >
      <Box sx={{ flex: 1 }}>
        <NotebookRow
          item={d}
          isEditMode={isEditMode}
          isChecked={selectedItems.has(d.id)}
          isShared={'isShared' in d ? d.isShared : false}
          favoriteSessions={favoriteSessions}
          showMessageCount={showMessageCount}
          suppressActive={suppressActive}
          activeAgentId={activeAgentId}
          onNavigate={onNavigate}
          onNotebookClick={onNotebookClick}
          onToggle={onToggle}
        />
      </Box>
    </Box>
  );

  return (
    <>
      {grouped.sortedGroupKeys.map(key => (
        <div className="combined-notebooks-group" key={key}>
          <Typography
            className="combined-notebooks-group-title"
            level="body-xs"
            sx={{ color: 'neutral.softDisabledColor', marginBottom: '0.1em' }}
          >
            {key}
          </Typography>
          {(shouldGroup
            ? collapseApiItems(grouped.groupSessions[key], key)
            : grouped.groupSessions[key].map(item => ({ kind: 'item' as const, item }))
          ).map(row => {
            if (row.kind === 'item') return renderRow(row.item);
            const expanded = !!expandedBuckets[row.key];
            return (
              <Box key={`api-group-${row.key}`} data-testid="sidenav-api-group">
                <Box
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  data-testid="sidenav-api-group-toggle"
                  onClick={() => toggleBucket(row.key)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleBucket(row.key);
                    }
                  }}
                  sx={theme => ({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    px: 1,
                    height: '32px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    color: 'text.secondary',
                    '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
                  })}
                >
                  {expanded ? (
                    <KeyboardArrowDownIcon sx={{ fontSize: '16px' }} />
                  ) : (
                    <KeyboardArrowRightIcon sx={{ fontSize: '16px' }} />
                  )}
                  <ApiIcon sx={{ fontSize: '14px', color: 'text.tertiary' }} />
                  <Typography level="body-xs" sx={{ color: 'inherit' }}>
                    {t('sidenav.apiGroup', 'API - {{count}} notebooks', { count: row.items.length })}
                  </Typography>
                </Box>
                {expanded && (
                  <Box data-testid="sidenav-api-group-items" sx={{ pl: '12px' }}>
                    {row.items.map(renderRow)}
                  </Box>
                )}
              </Box>
            );
          })}
        </div>
      ))}
    </>
  );
}
