import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  Stack,
  Card,
  Chip,
  IconButton,
  Tooltip,
  Input,
  Select,
  Option,
  Button,
  Grid,
  CircularProgress,
  Alert,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Badge,
  Menu,
  MenuButton,
  MenuItem,
  Dropdown,
  Divider,
} from '@mui/joy';
import {
  Search as SearchIcon,
  Add as AddIcon,
  Sort as SortIcon,
  GridView as GridIcon,
  ViewList as ListIcon,
  MoreVert as MoreIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Share as ShareIcon,
  Download as DownloadIcon,
  Refresh as RefreshIcon,
  Code as ReactIcon,
  Html as HtmlIcon,
  Image as SvgIcon,
  AccountTree as MermaidIcon,
  Description as CodeIcon,
  School as QuestIcon,
  InsertDriveFile as FileIcon,
  AutoAwesome as QuestMasterIcon,
} from '@mui/icons-material';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { type BaseArtifact } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { usePublishShare } from '@client/app/hooks/usePublishShare';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { buildArtifactPublishWiring } from '@client/app/utils/publishApi';

// Types
interface ArtifactWithContent extends BaseArtifact {
  content?: string;
  contentSize: number;
  contentHash: string;
}

interface ArtifactListResponse {
  artifacts: ArtifactWithContent[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

interface ArtifactTypesResponse {
  types: Array<{
    type: string;
    name: string;
    description: string;
    category: string;
  }>;
  categories: string[];
}

type ViewMode = 'grid' | 'list';
type SortBy = 'type' | 'title' | 'createdAt' | 'updatedAt';
type SortOrder = 'asc' | 'desc';

// Artifact type icons mapping
const ARTIFACT_ICONS = {
  react: ReactIcon,
  html: HtmlIcon,
  svg: SvgIcon,
  mermaid: MermaidIcon,
  code: CodeIcon,
  python: CodeIcon,
  quest: QuestIcon,
  file: FileIcon,
  questmaster: QuestMasterIcon,
  recharts: MermaidIcon,
} as const;

// Artifact type colors
const ARTIFACT_COLORS = {
  react: 'primary',
  html: 'warning',
  svg: 'success',
  mermaid: 'info',
  code: 'neutral',
  python: 'success',
  quest: 'primary',
  file: 'neutral',
  questmaster: 'danger',
  recharts: 'info',
} as const;

interface ArtifactGalleryProps {
  projectId?: string;
  sessionId?: string;
  onArtifactSelect?: (artifact: ArtifactWithContent) => void;
  onArtifactCreate?: () => void;
  onArtifactEdit?: (artifact: ArtifactWithContent) => void;
}

export const ArtifactGallery: React.FC<ArtifactGalleryProps> = ({
  projectId,
  sessionId,
  onArtifactSelect,
  onArtifactCreate,
  onArtifactEdit,
}) => {
  // Publish-and-share: render an artifact to a hosted static bundle (/p/u/... or, in a Team
  // account context, an org-scoped /p/o/...).
  const currentUser = useUser(s => s.currentUser);
  // Active account-switcher org (null in personal context). Enables the dialog's Team option
  // and org-scoped publishing; the server re-validates membership before trusting it.
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const activeOrg = selectedAccount && !selectedAccount.personal ? selectedAccount : null;
  const { publishAndShare, modal: publishShareModal } = usePublishShare();
  // Guards against re-entrant Share clicks racing two publishes onto the single dialog.
  const publishingRef = useRef(false);
  const handlePublishArtifact = useCallback(
    async (artifact: ArtifactWithContent) => {
      if (!currentUser?.id) {
        toast.error('You must be signed in to publish');
        return;
      }
      // The dialog detects a prior publication of this artifact (via resolveExisting) and
      // offers "update existing" (a new version) vs "publish as new". Route through
      // buildArtifactPublishWiring so the lookup and the publish share one stable id. Guard an
      // empty id: it both misses the lookup AND gets written as source.artifactId, corrupting
      // the linkage - mirrors the KnowledgeViewer publish path.
      const artifactId = artifact.id;
      if (!artifactId) {
        toast.error('This artifact has no stable id to publish');
        return;
      }
      // Ignore re-entrant clicks while a hydration fetch is already in flight: there is a
      // single share dialog, so two racing publishes would let the last-resolved one win it.
      // A ref (not state) keeps the guard synchronous and free of re-render churn.
      if (publishingRef.current) return;
      publishingRef.current = true;
      try {
        // The gallery renders from the list feed (/api/artifacts), which omits `content` to stay
        // lean. publishArtifactBundle throws on empty content before any network call, so hydrate
        // the single artifact (the :id GET includes content by default; the string lives at
        // response.content.content) before wiring up the publish dialog.
        let content = artifact.content ?? '';
        if (!content) {
          try {
            const { data } = await api.get<{ content?: { content?: string } }>(
              `/api/artifacts/${encodeURIComponent(artifactId)}?includeContent=true`
            );
            content = data.content?.content ?? '';
          } catch (err) {
            // A transport/auth failure is not the same as "empty content" - keep the two
            // distinct so a transient error doesn't send anyone chasing a data problem.
            console.error('Failed to load artifact content for publish:', err);
            toast.error('Could not load artifact content, please try again');
            return;
          }
        }
        if (!content) {
          toast.error('This artifact has no content to publish');
          return;
        }
        publishAndShare({
          title: artifact.title || 'Shared artifact',
          ...(activeOrg ? { orgOption: { label: 'Team', hint: `Members of ${activeOrg.name}` } } : {}),
          ...buildArtifactPublishWiring({
            artifactId,
            type: artifact.type,
            content,
            title: artifact.title,
            userId: String(currentUser.id),
            orgId: activeOrg?.id,
          }),
        });
      } finally {
        // Release once the dialog is open (or on any bail) - the guard only covers the
        // async hydration window, which is where the race lives.
        publishingRef.current = false;
      }
    },
    [currentUser, activeOrg, publishAndShare]
  );

  // State
  const [artifacts, setArtifacts] = useState<ArtifactWithContent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [sortBy, setSortBy] = useState<SortBy>('createdAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [selectedVisibility, setSelectedVisibility] = useState<string>('');
  const [currentTab, setCurrentTab] = useState(0);

  // Pagination
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  // Available types and categories
  const [artifactTypes, setArtifactTypes] = useState<ArtifactTypesResponse | null>(null);

  // Fetch artifact types
  const fetchArtifactTypes = useCallback(async () => {
    try {
      const response = await api.get<ArtifactTypesResponse>('/api/artifacts/types');
      setArtifactTypes(response.data);
    } catch (error) {
      console.error('Failed to fetch artifact types:', error);
    }
  }, []);

  // Fetch artifacts
  const fetchArtifacts = useCallback(
    async (reset = false) => {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams({
          limit: pageSize.toString(),
          offset: reset ? '0' : (currentPage * pageSize).toString(),
          sortBy,
          sortOrder,
          includeDeleted: 'false',
        });

        if (searchQuery) params.append('search', searchQuery);
        if (selectedType) params.append('type', selectedType);
        if (selectedStatus) params.append('status', selectedStatus);
        if (selectedVisibility) params.append('visibility', selectedVisibility);
        if (projectId) params.append('projectId', projectId);
        if (sessionId) params.append('sessionId', sessionId);

        const endpoint = searchQuery ? '/api/artifacts/search' : '/api/artifacts';
        const response = await api.get<ArtifactListResponse>(`${endpoint}?${params}`);

        if (reset) {
          setArtifacts(response.data.artifacts);
          setCurrentPage(0);
        } else {
          setArtifacts(prev => [...prev, ...response.data.artifacts]);
        }

        setHasMore(response.data.pagination.hasMore);
        setTotal(response.data.pagination.total);
      } catch (error: any) {
        setError(error.message || 'Failed to fetch artifacts');
        toast.error('Failed to load artifacts');
      } finally {
        setLoading(false);
      }
    },
    [
      currentPage,
      pageSize,
      sortBy,
      sortOrder,
      searchQuery,
      selectedType,
      selectedStatus,
      selectedVisibility,
      projectId,
      sessionId,
    ]
  );

  // Load more artifacts
  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      setCurrentPage(prev => prev + 1);
    }
  }, [loading, hasMore]);

  // Reset and refresh
  const refresh = useCallback(() => {
    setCurrentPage(0);
    fetchArtifacts(true);
  }, [fetchArtifacts]);

  // Handle search
  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setCurrentPage(0);
  }, []);

  // Handle filters
  const handleFilterChange = useCallback((key: string, value: string) => {
    switch (key) {
      case 'type':
        setSelectedType(value);
        break;
      case 'status':
        setSelectedStatus(value);
        break;
      case 'visibility':
        setSelectedVisibility(value);
        break;
      case 'category':
        setSelectedCategory(value);
        setSelectedType(''); // Reset type when category changes
        break;
    }
    setCurrentPage(0);
  }, []);

  // Handle sort
  const handleSort = useCallback(
    (newSortBy: SortBy, newSortOrder?: SortOrder) => {
      setSortBy(newSortBy);
      setSortOrder(newSortOrder || (newSortBy === sortBy && sortOrder === 'desc' ? 'asc' : 'desc'));
      setCurrentPage(0);
    },
    [sortBy, sortOrder]
  );

  // Delete artifact
  const handleDelete = useCallback(async (artifactId: string) => {
    try {
      await api.delete(`/api/artifacts/${artifactId}`);
      setArtifacts(prev => prev.filter(a => a.id !== artifactId));
      toast.success('Artifact deleted successfully');
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete artifact');
    }
  }, []);

  // Effects
  useEffect(() => {
    fetchArtifactTypes();
  }, [fetchArtifactTypes]);

  useEffect(() => {
    fetchArtifacts(true);
  }, [searchQuery, selectedType, selectedStatus, selectedVisibility, sortBy, sortOrder]);

  useEffect(() => {
    if (currentPage > 0) {
      fetchArtifacts(false);
    }
  }, [currentPage]);

  // Filter artifacts by category
  const filteredArtifacts = useMemo(() => {
    if (!selectedCategory || !artifactTypes) return artifacts;

    const categoryTypes = artifactTypes.types.filter(t => t.category === selectedCategory).map(t => t.type);

    return artifacts.filter(a => categoryTypes.includes(a.type));
  }, [artifacts, selectedCategory, artifactTypes]);

  // Group artifacts by category for tabs
  const artifactsByCategory = useMemo(() => {
    if (!artifactTypes) return {};

    const categories = artifactTypes.categories;
    const grouped: Record<string, ArtifactWithContent[]> = {};

    categories.forEach(category => {
      const categoryTypes = artifactTypes.types.filter(t => t.category === category).map(t => t.type);

      grouped[category] = artifacts.filter(a => categoryTypes.includes(a.type));
    });

    return grouped;
  }, [artifacts, artifactTypes]);

  // Render artifact card
  const renderArtifactCard = (artifact: ArtifactWithContent) => {
    const IconComponent = ARTIFACT_ICONS[artifact.type as keyof typeof ARTIFACT_ICONS] || CodeIcon;
    const color = ARTIFACT_COLORS[artifact.type as keyof typeof ARTIFACT_ICONS] || 'neutral';

    return (
      <Card
        key={artifact.id}
        variant="outlined"
        sx={{
          p: 2,
          cursor: 'pointer',
          transition: 'all 0.2s ease-in-out',
          '&:hover': {
            transform: 'translateY(-2px)',
            boxShadow: 'md',
          },
        }}
        onClick={() => onArtifactSelect?.(artifact)}
      >
        <Stack spacing={1}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
            <Stack direction="row" spacing={1} alignItems="center" flex={1}>
              <IconComponent color={color as any} />
              <Typography level="title-sm" noWrap flex={1}>
                {artifact.title}
              </Typography>
            </Stack>

            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{ root: { size: 'sm', variant: 'plain', 'data-testid': 'artifact-card-menu-btn' } }}
                onClick={e => e.stopPropagation()}
              >
                <MoreIcon />
              </MenuButton>
              <Menu>
                <MenuItem
                  onClick={e => {
                    e.stopPropagation();
                    onArtifactEdit?.(artifact);
                  }}
                >
                  <EditIcon sx={{ mr: 1 }} />
                  Edit
                </MenuItem>
                <MenuItem
                  onClick={e => {
                    e.stopPropagation();
                    // Deliberate fire-and-forget: the async handler drives its own toasts and
                    // opens the dialog; the menu click doesn't await it. `void` marks intent.
                    void handlePublishArtifact(artifact);
                  }}
                  data-testid="artifact-publish-share"
                >
                  <ShareIcon sx={{ mr: 1 }} />
                  Share
                </MenuItem>
                <MenuItem
                  onClick={e => {
                    e.stopPropagation(); /* Handle download */
                  }}
                >
                  <DownloadIcon sx={{ mr: 1 }} />
                  Download
                </MenuItem>
                <Divider />
                <MenuItem
                  color="danger"
                  onClick={e => {
                    e.stopPropagation();
                    handleDelete(artifact.id);
                  }}
                >
                  <DeleteIcon sx={{ mr: 1 }} />
                  Delete
                </MenuItem>
              </Menu>
            </Dropdown>
          </Stack>

          <Stack direction="row" spacing={1} alignItems="center">
            <Chip size="sm" variant="soft" color={color as any}>
              {artifact.type}
            </Chip>
            <Chip size="sm" variant="outlined">
              {artifact.status}
            </Chip>
          </Stack>

          {artifact.description && (
            <Typography level="body-sm" color="neutral" noWrap>
              {artifact.description}
            </Typography>
          )}

          <Stack direction="row" spacing={2} sx={{ fontSize: 'xs', color: 'text.tertiary' }}>
            <Typography level="body-xs">{new Date(artifact.createdAt).toLocaleDateString()}</Typography>
            <Typography level="body-xs">{Math.round(artifact.contentSize / 1024)}KB</Typography>
          </Stack>
        </Stack>
      </Card>
    );
  };

  if (!artifactTypes) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }}>
        <Typography level="h2" flex={1}>
          Artifact Gallery
        </Typography>

        <Stack direction="row" spacing={1}>
          <Tooltip title="Refresh">
            <IconButton variant="outlined" onClick={refresh} disabled={loading}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title={viewMode === 'grid' ? 'Switch to List' : 'Switch to Grid'}>
            <IconButton variant="outlined" onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}>
              {viewMode === 'grid' ? <ListIcon /> : <GridIcon />}
            </IconButton>
          </Tooltip>

          <Button startDecorator={<AddIcon />} onClick={onArtifactCreate}>
            Create Artifact
          </Button>
        </Stack>
      </Stack>

      {/* Search and Filters */}
      <Stack spacing={2} sx={{ mb: 3 }}>
        <Input
          placeholder="Search artifacts..."
          startDecorator={<SearchIcon />}
          value={searchQuery}
          onChange={e => handleSearch(e.target.value)}
          sx={{ maxWidth: 400 }}
        />

        <Stack direction="row" spacing={2} flexWrap="wrap">
          <Select
            placeholder="All Types"
            value={selectedType}
            onChange={(_, value) => handleFilterChange('type', value || '')}
            sx={{ minWidth: 120 }}
          >
            <Option value="">All Types</Option>
            {artifactTypes.types.map(type => (
              <Option key={type.type} value={type.type}>
                {type.name}
              </Option>
            ))}
          </Select>

          <Select
            placeholder="All Status"
            value={selectedStatus}
            onChange={(_, value) => handleFilterChange('status', value || '')}
            sx={{ minWidth: 120 }}
          >
            <Option value="">All Status</Option>
            <Option value="draft">Draft</Option>
            <Option value="review">Review</Option>
            <Option value="published">Published</Option>
            <Option value="archived">Archived</Option>
          </Select>

          <Select
            placeholder="All Visibility"
            value={selectedVisibility}
            onChange={(_, value) => handleFilterChange('visibility', value || '')}
            sx={{ minWidth: 120 }}
          >
            <Option value="">All Visibility</Option>
            <Option value="private">Private</Option>
            <Option value="project">Project</Option>
            <Option value="organization">Organization</Option>
            <Option value="public">Public</Option>
          </Select>

          <Dropdown>
            <MenuButton
              slots={{ root: Button }}
              slotProps={{ root: { variant: 'outlined', startDecorator: <SortIcon /> } }}
            >
              Sort
            </MenuButton>
            <Menu>
              <MenuItem onClick={() => handleSort('title')}>
                Title {sortBy === 'title' && (sortOrder === 'asc' ? '↑' : '↓')}
              </MenuItem>
              <MenuItem onClick={() => handleSort('type')}>
                Type {sortBy === 'type' && (sortOrder === 'asc' ? '↑' : '↓')}
              </MenuItem>
              <MenuItem onClick={() => handleSort('createdAt')}>
                Created {sortBy === 'createdAt' && (sortOrder === 'asc' ? '↑' : '↓')}
              </MenuItem>
              <MenuItem onClick={() => handleSort('updatedAt')}>
                Updated {sortBy === 'updatedAt' && (sortOrder === 'asc' ? '↑' : '↓')}
              </MenuItem>
            </Menu>
          </Dropdown>
        </Stack>
      </Stack>

      {/* Category Tabs */}
      <Tabs value={currentTab} onChange={(_, value) => setCurrentTab(value as number)} sx={{ mb: 2 }}>
        <TabList>
          <Tab>
            All
            <Badge badgeContent={total} size="sm" sx={{ ml: 1 }} />
          </Tab>
          {artifactTypes.categories.map((category, index) => (
            <Tab key={category}>
              {category.charAt(0).toUpperCase() + category.slice(1)}
              <Badge badgeContent={artifactsByCategory[category]?.length || 0} size="sm" sx={{ ml: 1 }} />
            </Tab>
          ))}
        </TabList>

        <TabPanel value={0} sx={{ p: 0, flex: 1 }}>
          {/* All Artifacts */}
          {error ? (
            <Alert color="danger">{error}</Alert>
          ) : (
            <Box sx={{ flex: 1, overflow: 'auto' }}>
              <Grid container spacing={2}>
                {filteredArtifacts.map(artifact => (
                  <Grid key={artifact.id} xs={12} sm={6} md={4} lg={3}>
                    {renderArtifactCard(artifact)}
                  </Grid>
                ))}
              </Grid>

              {loading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <CircularProgress />
                </Box>
              )}

              {hasMore && !loading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <Button variant="outlined" onClick={loadMore}>
                    Load More
                  </Button>
                </Box>
              )}

              {!loading && filteredArtifacts.length === 0 && (
                <Box sx={{ textAlign: 'center', py: 4 }}>
                  <Typography level="body-lg" color="neutral">
                    No artifacts found
                  </Typography>
                  <Typography level="body-sm" color="neutral" sx={{ mt: 1 }}>
                    Try adjusting your search or filters
                  </Typography>
                </Box>
              )}
            </Box>
          )}
        </TabPanel>

        {/* Category-specific tabs */}
        {artifactTypes.categories.map((category, index) => (
          <TabPanel key={category} value={index + 1} sx={{ p: 0, flex: 1 }}>
            <Box sx={{ flex: 1, overflow: 'auto' }}>
              <Grid container spacing={2}>
                {(artifactsByCategory[category] || []).map(artifact => (
                  <Grid key={artifact.id} xs={12} sm={6} md={4} lg={3}>
                    {renderArtifactCard(artifact)}
                  </Grid>
                ))}
              </Grid>

              {(artifactsByCategory[category] || []).length === 0 && (
                <Box sx={{ textAlign: 'center', py: 4 }}>
                  <Typography level="body-lg" color="neutral">
                    No {category} artifacts found
                  </Typography>
                </Box>
              )}
            </Box>
          </TabPanel>
        ))}
      </Tabs>
      {publishShareModal}
    </Box>
  );
};

export default ArtifactGallery;
