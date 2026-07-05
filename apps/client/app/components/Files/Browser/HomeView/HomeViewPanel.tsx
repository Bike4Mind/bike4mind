import { IFabFileDocument } from '@bike4mind/common';
import { useSearchFabFiles } from '@client/app/hooks/data/fabFiles';
import { useGetTagCounts } from '@client/app/hooks/data/tag';
import { Box, Card, Chip, CircularProgress, List, ListItemButton, ListItemContent, Stack, Typography } from '@mui/joy';
import { FieldTooltip } from '@client/app/components/help';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FolderIcon from '@mui/icons-material/Folder';
import { FC, useMemo, useState } from 'react';
import BugReportIcon from '@mui/icons-material/BugReport';
import { IconButton, Textarea } from '@mui/joy';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getFileIcon } from '../Item';
import { getTagColor } from '../TagView/tagColors';

dayjs.extend(relativeTime);

interface HomeViewPanelProps {
  onNavigateToNamespace: (namespace: string) => void;
  onFileSelect: (fileId: string) => void;
  selectedIds: Set<string>;
}

interface WorkspaceRow {
  namespace: string;
  totalCount: number;
  children: { segment: string; count: number }[];
}

function buildWorkspaces(
  tagCounts: { tag: string; count: number }[],
  namespaceCounts: { namespace: string; fileCount: number }[] = []
): WorkspaceRow[] {
  // Build a lookup from namespace -> unique file count
  const nsFileCountMap = new Map<string, number>();
  for (const { namespace, fileCount } of namespaceCounts) {
    nsFileCountMap.set(namespace, fileCount);
  }

  const nsMap = new Map<string, { children: Map<string, number> }>();

  for (const { tag, count } of tagCounts) {
    const parts = tag.split(':');
    const root = parts[0];

    if (!nsMap.has(root)) {
      nsMap.set(root, { children: new Map() });
    }
    const ns = nsMap.get(root)!;

    if (parts.length > 1) {
      const child = parts[1];
      ns.children.set(child, (ns.children.get(child) || 0) + count);
    }
  }

  return Array.from(nsMap.entries())
    .map(([namespace, { children }]) => ({
      namespace,
      // Use unique file count from server, fall back to child count sum
      totalCount: nsFileCountMap.get(namespace) ?? 0,
      children: Array.from(children.entries())
        .map(([segment, count]) => ({ segment, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    }))
    .sort((a, b) => b.totalCount - a.totalCount);
}

const HomeViewPanel: FC<HomeViewPanelProps> = ({ onNavigateToNamespace, onFileSelect, selectedIds }) => {
  const { data: recentData, isLoading: isLoadingRecent } = useSearchFabFiles({
    order: { by: 'createdAt', direction: 'desc' },
    pagination: { page: 1, limit: 8 },
  });
  const { data: tagCountsData, isLoading: isLoadingTags } = useGetTagCounts();

  const recentFiles = recentData?.data?.slice(0, 8) || [];
  const workspaces = useMemo(
    () =>
      tagCountsData?.tagCounts ? buildWorkspaces(tagCountsData.tagCounts, tagCountsData.namespaceCounts ?? []) : [],
    [tagCountsData]
  );
  const visibleWorkspaces = workspaces.slice(0, 6);
  const overflowCount = workspaces.length - 6;
  const [showDebug, setShowDebug] = useState(false);

  const debugDump = useMemo(() => {
    if (!showDebug || !tagCountsData) return '';
    const totalSearchFiles = recentData?.total ?? '?';
    const nsCounts = tagCountsData.namespaceCounts ?? [];
    const tagCounts = tagCountsData.tagCounts ?? [];

    const lines: string[] = [
      `Total Files (from search): ${totalSearchFiles}`,
      '',
      '=== Namespace Counts (unique files per namespace) ===',
      ...nsCounts.map(ns => `  ${ns.namespace}: ${ns.fileCount}`),
      '',
      '=== Workspace Rows (after buildWorkspaces) ===',
      ...workspaces.map(
        ws =>
          `  ${ws.namespace}: totalCount=${ws.totalCount}, children=[${ws.children.map(c => `${c.segment}(${c.count})`).join(', ')}]`
      ),
      '',
      `=== Raw Tag Counts (${tagCounts.length} tags) ===`,
      ...tagCounts.slice(0, 30).map(tc => `  ${tc.tag}: ${tc.count}`),
      tagCounts.length > 30 ? `  ... and ${tagCounts.length - 30} more` : '',
    ];
    return lines.join('\n');
  }, [showDebug, tagCountsData, recentData, workspaces]);

  if (isLoadingRecent || isLoadingTags) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress size="md" />
      </Box>
    );
  }

  return (
    <Stack data-testid="home-view-panel" sx={{ flex: 1, minHeight: 0, overflow: 'auto', gap: 3 }}>
      {/* Section 1: Recent */}
      {recentFiles.length > 0 && (
        <Stack gap={1.5}>
          <Typography
            level="body-xs"
            sx={{
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              color: 'neutral.500',
              fontWeight: 600,
              px: 0.5,
            }}
          >
            Recent
          </Typography>
          <Box
            sx={{
              display: 'flex',
              gap: 1.5,
              overflowX: 'auto',
              pt: 1,
              pb: 0.5,
              '&::-webkit-scrollbar': { height: 4 },
              '&::-webkit-scrollbar-thumb': { borderRadius: 2, bgcolor: 'neutral.300' },
            }}
          >
            {recentFiles.map(file => (
              <RecentFileCard
                key={file.id}
                file={file}
                selected={selectedIds.has(file.id)}
                onClick={() => onFileSelect(file.id)}
              />
            ))}
          </Box>
        </Stack>
      )}

      {/* Section 2: Workspaces */}
      {visibleWorkspaces.length > 0 && (
        <Stack gap={1.5}>
          <Stack direction="row" alignItems="center" gap={0.5}>
            <Typography
              level="body-xs"
              sx={{
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'neutral.500',
                fontWeight: 600,
                px: 0.5,
              }}
            >
              Workspaces
            </Typography>
            <FieldTooltip
              ariaLabel="Help: Workspaces"
              content='Each workspace groups files by their tag namespace (e.g. "opti:"). The number next to each workspace is the count of unique files tagged in that namespace. A file can belong to multiple workspaces if it has tags from different namespaces. The sub-labels (e.g. "solver (194)") show tag assignment counts within that namespace — these can be higher because a single file often carries several related tags.'
              placement="bottom-start"
            />
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => setShowDebug(prev => !prev)}
              sx={{ opacity: 0.3, '&:hover': { opacity: 0.8 }, minWidth: 24, minHeight: 24, p: 0.25 }}
            >
              <BugReportIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Stack>
          {showDebug && (
            <Textarea
              readOnly
              value={debugDump}
              minRows={8}
              maxRows={20}
              sx={{ fontFamily: 'monospace', fontSize: '11px', bgcolor: 'background.level1' }}
            />
          )}
          <List
            sx={{
              '--ListItem-paddingY': '0px',
              '--ListItem-paddingX': '0px',
              gap: 0.5,
            }}
          >
            {visibleWorkspaces.map(ws => (
              <ListItemButton
                key={ws.namespace}
                data-testid={`workspace-row-${ws.namespace}`}
                onClick={() => onNavigateToNamespace(ws.namespace)}
                sx={{
                  borderRadius: '8px',
                  px: 2,
                  py: 1.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    borderRadius: '6px',
                    backgroundColor: `${getTagColor(ws.namespace)}15`,
                    color: getTagColor(ws.namespace),
                    flexShrink: 0,
                  }}
                >
                  <FolderIcon fontSize="small" />
                </Box>
                <ListItemContent sx={{ minWidth: 0 }}>
                  <Typography level="body-md" sx={{ fontWeight: 600 }}>
                    {ws.namespace}
                  </Typography>
                  {ws.children.length > 0 && (
                    <Typography level="body-xs" sx={{ color: 'neutral.500', mt: 0.25 }}>
                      {ws.children.map(c => `${c.segment} (${c.count})`).join(' \u00B7 ')}
                    </Typography>
                  )}
                </ListItemContent>
                <Chip size="sm" variant="soft" color="neutral" sx={{ fontWeight: 600, minWidth: 28 }}>
                  {ws.totalCount}
                </Chip>
                <ChevronRightIcon sx={{ color: 'neutral.400', fontSize: 20 }} />
              </ListItemButton>
            ))}
          </List>
          {overflowCount > 0 && (
            <Typography
              level="body-xs"
              sx={{ color: 'primary.500', cursor: 'pointer', pl: 2, '&:hover': { textDecoration: 'underline' } }}
              onClick={() => onNavigateToNamespace('')}
            >
              +{overflowCount} more
            </Typography>
          )}
        </Stack>
      )}
    </Stack>
  );
};

const RecentFileCard: FC<{ file: IFabFileDocument; selected: boolean; onClick: () => void }> = ({
  file,
  selected,
  onClick,
}) => {
  return (
    <Card
      data-testid={`recent-file-${file.id}`}
      variant="outlined"
      size="sm"
      onClick={onClick}
      sx={{
        minWidth: 120,
        maxWidth: 140,
        cursor: 'pointer',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.75,
        p: 1.5,
        position: 'relative',
        transition: 'box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease',
        borderColor: selected ? 'primary.500' : undefined,
        boxShadow: selected ? '0 0 0 1px var(--joy-palette-primary-500)' : undefined,
        '&:hover': {
          boxShadow: selected ? '0 0 0 1px var(--joy-palette-primary-500)' : 'md',
          transform: 'translateY(-2px)',
        },
      }}
    >
      {selected && (
        <CheckCircleIcon
          sx={{
            position: 'absolute',
            top: 4,
            right: 4,
            fontSize: 18,
            color: 'primary.500',
          }}
        />
      )}
      <Box sx={{ color: selected ? 'primary.500' : 'neutral.500' }}>{getFileIcon(file, 32)}</Box>
      <Typography
        level="body-xs"
        sx={{
          textAlign: 'center',
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          lineHeight: 1.3,
          width: '100%',
        }}
      >
        {file.fileName}
      </Typography>
      <Typography level="body-xs" sx={{ color: 'neutral.400', fontSize: '11px' }}>
        {dayjs(file.createdAt).fromNow()}
      </Typography>
    </Card>
  );
};

export default HomeViewPanel;
