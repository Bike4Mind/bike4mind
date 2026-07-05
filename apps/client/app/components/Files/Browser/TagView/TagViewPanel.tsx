import { Box, Breadcrumbs, Checkbox, CircularProgress, IconButton, Link, Stack, Tooltip, Typography } from '@mui/joy';
import HomeIcon from '@mui/icons-material/Home';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import TagIcon from '@mui/icons-material/LocalOffer';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { FC, useMemo, useState } from 'react';
import { useGetTagCounts } from '@client/app/hooks/data/tag';
import { buildTagTree, getNodesAtPath, TagNode } from './parseTagNamespace';
import TagCard from './TagCard';

type SortField = 'name' | 'count';
type SortDirection = 'asc' | 'desc';

function sortNodes(nodes: TagNode[], field: SortField, direction: SortDirection): TagNode[] {
  return [...nodes].sort((a, b) => {
    const cmp = field === 'name' ? a.segment.localeCompare(b.segment) : a.fileCount - b.fileCount;
    return direction === 'asc' ? cmp : -cmp;
  });
}

interface TagViewPanelProps {
  onFilterByTag: (tagName: string) => void;
  initialNamespace?: string;
}

const TagViewPanel: FC<TagViewPanelProps> = ({ onFilterByTag, initialNamespace }) => {
  const { data: tagCountsData, isLoading } = useGetTagCounts();
  const tagCounts = tagCountsData?.tagCounts;
  const [breadcrumb, setBreadcrumb] = useState<string[]>(initialNamespace ? [initialNamespace] : []);
  const [sortField, setSortField] = useState<SortField>('count');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [hideSingletons, setHideSingletons] = useState(true);

  const tree = useMemo(() => {
    if (!tagCounts) return [];
    return buildTagTree(tagCounts);
  }, [tagCounts]);

  const currentNodes = useMemo(() => {
    return getNodesAtPath(tree, breadcrumb);
  }, [tree, breadcrumb]);

  // If breadcrumb points to a level with no children, reset to root
  const rawDisplayNodes = currentNodes.length > 0 ? currentNodes : tree;
  const displayBreadcrumb = currentNodes.length > 0 ? breadcrumb : [];

  const filteredNodes = useMemo(
    () => (hideSingletons ? rawDisplayNodes.filter(n => n.fileCount > 1) : rawDisplayNodes),
    [rawDisplayNodes, hideSingletons]
  );

  const singletonCount = rawDisplayNodes.length - rawDisplayNodes.filter(n => n.fileCount > 1).length;

  const displayNodes = useMemo(
    () => sortNodes(filteredNodes, sortField, sortDirection),
    [filteredNodes, sortField, sortDirection]
  );

  const handleSortToggle = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'count' ? 'desc' : 'asc');
    }
  };

  const handleCardClick = (node: (typeof displayNodes)[number]) => {
    if (node.children.length > 0) {
      setBreadcrumb([...displayBreadcrumb, node.segment]);
    } else {
      onFilterByTag(node.fullPath);
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index < 0) {
      setBreadcrumb([]);
    } else {
      setBreadcrumb(displayBreadcrumb.slice(0, index + 1));
    }
  };

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress size="md" />
      </Box>
    );
  }

  if (!tagCounts || tagCounts.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <Typography level="body-md" sx={{ color: 'text.tertiary' }}>
          No tagged files found. Add tags to your files to see them here.
        </Typography>
      </Box>
    );
  }

  return (
    <Stack data-testid="tag-view-panel" sx={{ flex: 1, minHeight: 0, overflow: 'auto', gap: 2 }}>
      {/* Breadcrumb navigation */}
      <Breadcrumbs separator={<NavigateNextIcon fontSize="small" />} sx={{ px: 0.5 }}>
        <Link
          component="button"
          underline="hover"
          color={displayBreadcrumb.length === 0 ? 'primary' : 'neutral'}
          onClick={() => handleBreadcrumbClick(-1)}
          startDecorator={<HomeIcon fontSize="small" />}
          sx={{ fontSize: '14px', fontWeight: displayBreadcrumb.length === 0 ? 600 : 400 }}
        >
          All Tags
        </Link>
        {displayBreadcrumb.map((segment, idx) => {
          const isLast = idx === displayBreadcrumb.length - 1;
          return (
            <Link
              key={segment}
              component="button"
              underline={isLast ? 'none' : 'hover'}
              color={isLast ? 'primary' : 'neutral'}
              onClick={() => handleBreadcrumbClick(idx)}
              sx={{ fontSize: '14px', fontWeight: isLast ? 600 : 400 }}
            >
              {segment}
            </Link>
          );
        })}
      </Breadcrumbs>

      {/* Sort controls + filter */}
      <Stack direction="row" gap={1} sx={{ px: 0.5, alignItems: 'center' }}>
        <Tooltip title={`Sort by name (${sortField === 'name' ? (sortDirection === 'asc' ? 'A→Z' : 'Z→A') : 'A→Z'})`}>
          <IconButton
            size="sm"
            variant={sortField === 'name' ? 'soft' : 'plain'}
            color={sortField === 'name' ? 'primary' : 'neutral'}
            onClick={() => handleSortToggle('name')}
          >
            <SortByAlphaIcon fontSize="small" />
            {sortField === 'name' &&
              (sortDirection === 'asc' ? (
                <ArrowUpwardIcon sx={{ fontSize: 14, ml: -0.5 }} />
              ) : (
                <ArrowDownwardIcon sx={{ fontSize: 14, ml: -0.5 }} />
              ))}
          </IconButton>
        </Tooltip>
        <Tooltip
          title={`Sort by count (${sortField === 'count' ? (sortDirection === 'desc' ? 'most first' : 'fewest first') : 'most first'})`}
        >
          <IconButton
            size="sm"
            variant={sortField === 'count' ? 'soft' : 'plain'}
            color={sortField === 'count' ? 'primary' : 'neutral'}
            onClick={() => handleSortToggle('count')}
          >
            <TagIcon fontSize="small" />
            {sortField === 'count' &&
              (sortDirection === 'desc' ? (
                <ArrowDownwardIcon sx={{ fontSize: 14, ml: -0.5 }} />
              ) : (
                <ArrowUpwardIcon sx={{ fontSize: 14, ml: -0.5 }} />
              ))}
          </IconButton>
        </Tooltip>

        <Box sx={{ mx: 0.5, height: 20, borderLeft: '1px solid', borderColor: 'divider' }} />

        <Checkbox
          size="sm"
          checked={hideSingletons}
          onChange={e => setHideSingletons(e.target.checked)}
          label={`Hide singletons${singletonCount > 0 ? ` (${singletonCount})` : ''}`}
          sx={{ '& .MuiCheckbox-label': { fontSize: '13px' } }}
        />
      </Stack>

      {/* Tag cards grid */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, 1fr)',
            md: 'repeat(3, 1fr)',
          },
          gap: 1.5,
        }}
      >
        {displayNodes.map(node => (
          <TagCard key={node.fullPath} node={node} onClick={() => handleCardClick(node)} />
        ))}
      </Box>
    </Stack>
  );
};

export default TagViewPanel;
