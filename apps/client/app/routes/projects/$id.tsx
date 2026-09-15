import {
  Box,
  CircularProgress,
  Input,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  IconButton,
  Tooltip,
  Select,
  Option,
  Typography,
  Stack,
  Divider,
} from '@mui/joy';
import EditNoteIcon from '@mui/icons-material/EditNote';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { useGetProjectSessions } from '@client/app/hooks/data/sessions';
import { useParams, useNavigate } from '@tanstack/react-router';
import { debounce } from 'lodash';
import SearchIcon from '@mui/icons-material/Search';
import { IProjectDocument, ISessionDocument } from '@bike4mind/common';
import { useGetProject } from '@client/app/hooks/data/projects';
import { useGetUser } from '@client/app/hooks/data/user';
import ProjectSession from '@client/app/components/Project/Session';
import { ProjectFiles } from '@client/app/components/Project/Files';
import ProjectAddSessionsModal from '@client/app/components/Project/AddSessionsModal';
import { useUser } from '@client/app/contexts/UserContext';
import { SystemPrompts } from '@client/app/components/Project/SystemPromptModal';
import ProjectMembersSection from '@client/app/components/Project/Members';
import { updateAllQueryData, useSubscribeCollection } from '@client/app/utils/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink } from '@tanstack/react-router';
import Breadcrumbs from '@client/app/components/common/Breadcrumbs';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { ProjectEvents } from '@bike4mind/common';
import { useGetProjectFiles } from '@client/app/hooks/data/fabFiles';
import { useTranslation } from 'react-i18next';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';

const ProjectPage = () => {
  const { id: projectId } = useParams({ strict: false });
  const navigate = useNavigate();
  const { data: project, isLoading, isError } = useGetProject(projectId!);
  const {
    data: files = [],
    isLoading: isFilesLoading,
    isFetching: isFilesFetching,
    refetch: refetchFiles,
  } = useGetProjectFiles(projectId!);

  useDocumentTitle(project?.name, ' | Project');

  const handleRefreshFiles = useCallback(async () => {
    await refetchFiles();
  }, [refetchFiles]);

  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const logEvent = useLogEvent();
  const { t } = useTranslation();

  useSubscribeCollection<IProjectDocument>(
    'projects',
    useMemo(() => (projectId ? { id: projectId } : null), [projectId]),
    useCallback(
      (_type: string, data: IProjectDocument) => {
        updateAllQueryData(queryClient, 'projects', 'write', data);
      },
      [queryClient]
    )
  );

  useEffect(() => {
    if (isError && !project) {
      navigate({ to: '/projects' });
    }
  }, [isError, project, navigate]);

  // Log project view event when the page loads and project data is available
  useEffect(() => {
    const projectId = project?.id;
    if (projectId && currentUser?.id && !isLoading) {
      const hasLogged = sessionStorage.getItem(`viewed-project-${projectId}`);
      if (!hasLogged) {
        logEvent.mutate({
          type: ProjectEvents.VIEW_PROJECT,
          metadata: {
            projectId,
            projectName: project.name || '',
          },
        });
        sessionStorage.setItem(`viewed-project-${projectId}`, 'true');
      }
    }
  }, [project?.id, currentUser?.id, isLoading, logEvent, project?.name]);

  return (
    <>
      <Box height={'52px'} alignItems="center" display="flex">
        <Breadcrumbs items={[{ name: 'Projects', href: '/projects' }, { name: project?.name ?? '' }]} />
      </Box>
      <Stack
        gap="20px"
        height="100vh"
        sx={theme => ({
          p: 0,
          '& ::-webkit-scrollbar-thumb': {
            backgroundColor: theme.palette.background.scrollbar,
            border: `2px solid ${theme.palette.background.scrollbarTrack}`,
            borderRadius: '20px',
          },
          '& ::-webkit-scrollbar': {
            width: '8px',
          },
          '& ::-webkit-scrollbar-track': {
            backgroundColor: theme.palette.background.scrollbarTrack,
          },
        })}
      >
        {isLoading || !project ? (
          <Box display="flex" justifyContent="center" alignItems="center" height="100%" width="100%">
            <CircularProgress />
          </Box>
        ) : (
          <>
            <ProjectHeader project={project} />
            <Tabs sx={{ flexGrow: 1, p: 0, gap: '20px', overflow: 'auto' }}>
              <TabList
                data-testid="project-tab-list"
                sx={{
                  mx: { xs: '8px', sm: '20px' },
                  gap: { xs: '4px', sm: '8px' },
                  borderBottom: '1px solid',
                  borderColor: theme =>
                    theme.palette.mode === 'dark' ? 'rgba(211, 223, 232, 0.15)' : 'rgba(51, 95, 112, 0.15)',
                  flexWrap: { xs: 'wrap', sm: 'nowrap' },
                  '& .MuiTab-root': {
                    borderBottomRightRadius: '0px',
                    borderBottomLeftRadius: '0px',
                    color: theme =>
                      theme.palette.mode === 'dark' ? 'rgba(209, 228, 244, 0.7)' : 'rgba(51, 95, 112, 0.8)',
                    height: '40px',
                    minWidth: { xs: 'calc(50% - 2px)', sm: 'auto' },
                    flex: { xs: '0 0 calc(50% - 2px)', sm: '0 0 auto' },
                    '&:not(.Mui-selected):hover': {
                      backgroundColor: theme => `${theme.palette.notebooklist.hoverBg} !important`,
                      color: theme => (theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70'),
                    },
                    '&.Mui-selected': {
                      color: theme => (theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70'),
                    },
                  },
                }}
              >
                <Tab data-testid="project-tab-notebooks">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                    <EditNoteIcon sx={{ fontSize: 16 }} />
                    <Box sx={{ fontSize: '14px', textAlign: 'center' }}>
                      {t('file_browser.session', { count: project.sessionIds.length })} ({project.sessionIds.length})
                    </Box>
                  </Box>
                </Tab>
                <Tab data-testid="project-tab-files">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                    <FolderOutlinedIcon sx={{ fontSize: 16 }} />
                    <Box sx={{ fontSize: '14px', textAlign: 'center' }}>Project Files ({files.length})</Box>
                  </Box>
                </Tab>
                <Tab data-testid="project-tab-members">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                    <PersonOutlineIcon sx={{ fontSize: 16 }} />
                    <Box sx={{ fontSize: '14px', textAlign: 'center' }}>Members ({project.users.length})</Box>
                  </Box>
                </Tab>
                <Tab data-testid="project-tab-system-prompts">
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
                    <SettingsOutlinedIcon sx={{ fontSize: 16 }} />
                    <Box sx={{ fontSize: '14px', textAlign: 'center' }}>
                      System Prompts ({project.systemPrompts.length})
                    </Box>
                  </Box>
                </Tab>
              </TabList>
              <TabPanel value={0} sx={{ padding: '0 0 20px 0', overflow: 'auto' }}>
                <ProjectNotebookSection projectId={projectId!} />
              </TabPanel>
              <TabPanel value={1} sx={{ padding: '0 0 20px 0' }}>
                <ProjectFiles
                  projectId={projectId!}
                  files={files}
                  isLoading={isFilesLoading}
                  isFetching={isFilesFetching}
                  onRefresh={handleRefreshFiles}
                />
              </TabPanel>
              <TabPanel value={2} sx={{ padding: '0 0 20px 0' }}>
                {currentUser?.id && <ProjectMembersSection project={project} ownerId={currentUser.id} />}
              </TabPanel>
              <TabPanel value={3} sx={{ padding: '0 0 20px 0' }}>
                <SystemPrompts project={project} />
              </TabPanel>
            </Tabs>
          </>
        )}
      </Stack>
    </>
  );
};

const ProjectHeader: FC<{ project: IProjectDocument }> = ({ project }) => {
  const { name, userId } = project;
  const { data: user } = useGetUser(userId);

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        mx: '20px',
        flexDirection: {
          xs: 'column',
          sm: 'row',
        },
        gap: '10px',
      }}
    >
      <Stack sx={{ my: '10px', gap: '8px' }}>
        <Box sx={{ fontSize: '20px', color: theme => (theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70') }}>
          {name}
        </Box>
        <Box display="flex" gap="5px">
          <Typography
            sx={{
              color: theme => (theme.palette.mode === 'dark' ? 'rgba(209, 228, 244, 0.50)' : 'rgba(51, 95, 112, 0.50)'),
              fontSize: '16px',
            }}
          >
            Owner:
          </Typography>
          <Tooltip title="View Profile">
            <RouterLink
              to={`/profile/$id`}
              params={{ id: userId }}
              style={{ color: '#0B6BCB', textDecoration: 'underline', fontSize: '16px', fontWeight: 500 }}
            >
              {user?.name}
            </RouterLink>
          </Tooltip>
        </Box>
      </Stack>
    </Box>
  );
};

const ProjectNotebookSection: FC<{ projectId: string }> = ({ projectId }) => {
  const [search, setSearch] = useState('');
  const { data: sessions, isLoading, isFetching, refetch } = useGetProjectSessions(projectId);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [tag, setTag] = useState<null | string>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  function toggleSortOrder() {
    setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
  }

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refetch();
    } finally {
      setIsRefreshing(false);
    }
  }, [refetch]);

  const debouncedSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
      }, 300),
    []
  );

  // Client-side search filtering
  const [filteredSessions, availableTags] = useMemo(() => {
    if (!sessions) return [];
    let result = sessions;
    if (search) {
      const searchLower = search.toLowerCase();
      result = sessions.filter(session => session.name.toLowerCase().includes(searchLower));
    }
    if (tag && tag !== 'all') {
      // Only filter by tag if a specific tag is selected
      result = result.filter(session => session.tags?.some(t => t.name === tag));
    }

    const sorted = result.sort((a, b) =>
      sortOrder === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name)
    );

    const tags: string[] = sessions.reduce((acc, session) => {
      session.tags?.forEach(tag => {
        if (!acc.includes(tag.name) && tag.name !== '<favorite>') {
          acc.push(tag.name);
        }
      });
      return acc;
    }, [] as string[]);
    tags.sort((a, b) => a.localeCompare(b));

    return [sorted, tags];
  }, [sessions, search, sortOrder, tag]);

  return (
    <Stack gap="20px" sx={{ height: '100%' }}>
      <Box
        sx={{
          flexDirection: {
            xs: 'column',
            sm: 'row',
          },
          display: 'flex',
          gap: '12px',
          mx: '20px',
        }}
      >
        <Input
          sx={theme => ({
            flexGrow: 1,
            color: theme.palette.searchbar.color,
            border: `1px solid ${theme.palette.border.input}`,
            background: theme.palette.searchbar.background,
            fontSize: '14px',
            fontWeight: 400,
            lineHeight: '100%',
            fontStyle: 'normal',
            borderRadius: '8px',
            boxShadow: '0px 1px 50px 0px rgba(42, 65, 89, 0.03)',
            '&:focus-within .MuiSvgIcon-root': {
              color: theme.palette.mode === 'dark' ? '#fff' : '#000',
            },
          })}
          placeholder="Search"
          onChange={e => {
            debouncedSearch(e.target.value);
          }}
          startDecorator={
            <SearchIcon
              sx={theme => ({
                width: '20px',
                height: '20px',
                color: 'grey',
              })}
            />
          }
          endDecorator={isFetching && <CircularProgress size="sm" />}
        />
        <Tooltip title={'Filter by tag'}>
          <Select
            sx={theme => ({
              minWidth: '120px',
              borderRadius: '8px',
              color: theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70',
              background: theme.palette.searchbar.background,
              border: `1px solid ${theme.palette.border.input}`,
              boxShadow: 'none',
            })}
            indicator={
              <KeyboardArrowDownIcon
                sx={{ color: theme => (theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70'), opacity: 0.7 }}
              />
            }
            value={tag}
            onChange={(e, val) => setTag(val)}
            defaultValue={'all'}
            placeholder="Filter by tag"
          >
            <Option key="0" value={'all'}>
              All Tags
            </Option>
            {availableTags?.map(tag => {
              return (
                <Option key={tag} value={tag}>
                  {tag}
                </Option>
              );
            })}
          </Select>
        </Tooltip>
        <Tooltip title={`Sort by Name ${sortOrder === 'desc' ? 'Z → A' : 'A → Z'}`}>
          <IconButton
            variant="outlined"
            onClick={toggleSortOrder}
            sx={
              sortOrder === 'desc' || sortOrder === 'asc'
                ? {
                    borderColor: '#0B6BCB',
                    borderWidth: 1,
                    background: 'rgba(11, 107, 203, 0.08)',
                    '&:hover': {
                      borderColor: '#0B6BCB',
                      background: 'rgba(11, 107, 203, 0.12)',
                    },
                  }
                : {
                    '&:hover': {
                      background: 'rgba(51, 95, 112, 0.08)',
                    },
                  }
            }
          >
            <SortByAlphaIcon sx={{ fontSize: 20, transform: sortOrder === 'desc' ? 'scaleY(-1)' : 'none' }} />
          </IconButton>
        </Tooltip>
        <Divider orientation="vertical" sx={{ height: '40px', mx: '8px' }} />
        <Tooltip title="Refresh">
          <IconButton
            variant="outlined"
            onClick={handleRefresh}
            disabled={isRefreshing}
            data-testid="refresh-notebooks-btn"
            sx={{
              '&:hover': {
                background: 'rgba(51, 95, 112, 0.08)',
              },
            }}
          >
            {isRefreshing ? <CircularProgress size="sm" /> : <RefreshIcon sx={{ fontSize: 20 }} />}
          </IconButton>
        </Tooltip>
        <ProjectAddSessionsModal projectId={projectId} />
      </Box>

      {isLoading ? (
        <Box display="flex" mt={'100px'} flexGrow={1} alignItems="center" justifyContent="center">
          <CircularProgress />
        </Box>
      ) : (
        <Stack flexGrow={1} sx={{ overflow: 'auto' }} gap="10px" ml="20px" pr="16px" mb="60px">
          {filteredSessions && filteredSessions?.length > 0 ? (
            filteredSessions.map((session: ISessionDocument) => (
              <ProjectSession key={session.id} session={session} projectId={projectId} />
            ))
          ) : (
            <Box display="flex" justifyContent="center" alignItems="center" py={4}>
              <Typography level="body-lg" color="neutral">
                No notebooks found. {search ? 'Try adjusting your search or filters.' : ''}
              </Typography>
            </Box>
          )}
        </Stack>
      )}
    </Stack>
  );
};

export default ProjectPage;
