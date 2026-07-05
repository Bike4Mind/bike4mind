import { Box, Typography } from '@mui/joy';
import { useMemo } from 'react';
import { ISessionDocument, ISessionFavoriteItem } from '@bike4mind/common';
import { getDateLabel } from '@client/app/utils/dateUtils';
import { compareDateGroupKeys, groupItemsByDate } from './dateGrouping';
import NotebookRow from './NotebookRow';
import type { CombinedItem } from './types';

interface NotebookGroupListProps {
  items: CombinedItem[];
  /** Favorites are rendered separately above this list and excluded here (matched by id). */
  favoriteItems: { id: string }[];
  isEditMode: boolean;
  selectedItems: Set<string>;
  favoriteSessions?: ISessionFavoriteItem[];
  showMessageCount: boolean;
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
  onNavigate,
  onNotebookClick,
  onToggle,
}: NotebookGroupListProps) {
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
          {grouped.groupSessions[key].map(d => (
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
                  disableExportOps={false}
                  onNavigate={onNavigate}
                  onNotebookClick={onNotebookClick}
                  onToggle={onToggle}
                />
              </Box>
            </Box>
          ))}
        </div>
      ))}
    </>
  );
}
