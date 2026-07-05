import { IProjectDocument } from '@bike4mind/common';
import { useSearchProjects } from '@client/app/hooks/data/projects';
import { Box, CircularProgress, Grid, Typography } from '@mui/joy';
import { FC, useCallback, useState, useEffect } from 'react';
import { useDetectScrollBottom } from '@client/app/hooks/useDetectScrollBottom';
import ProjectCard from '@client/app/components/Project/Card';
import ProjectCreateModal from '@client/app/components/Project/CreateModal';
import SearchBar from '@client/app/components/Session/SearchBar';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { ContextHelpButton } from '@client/app/components/help';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';

const ProjectSection: FC<{
  title: string;
  projects: IProjectDocument[];
  loading?: boolean;
  loadingMore?: boolean;
}> = ({ title, projects = [], loading = false, loadingMore = false }) => {
  return (
    <Box display="flex" flexDirection="column" gap="20px" minHeight="400px">
      <Box sx={{ fontSize: '16px', lineHeight: '16px', fontWeight: '400' }}>{title}</Box>
      {loading ? (
        <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} py={8}>
          <CircularProgress data-testid="loading-projects-spinner" size="lg" sx={{ mb: 2 }} />
          <Typography level="body-md" color="neutral">
            Loading projects...
          </Typography>
        </Box>
      ) : projects.length === 0 ? (
        <Box
          data-testid="projects-empty-state"
          display="flex"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          flexGrow={1}
          gap={2}
          py={8}
        >
          <FolderOpenOutlinedIcon sx={{ fontSize: 64, color: 'text.tertiary', opacity: 0.5 }} />
          <Typography level="title-lg" sx={{ color: 'text.primary' }}>
            No projects yet
          </Typography>
          <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', maxWidth: 360 }}>
            Projects help you organize sessions, files, and collaborators in one place. Create one to get started.
          </Typography>
          <ProjectCreateModal label="Create your first project" testId="projects-empty-create-btn" />
        </Box>
      ) : (
        <>
          <Grid columns={24} spacing={'20px'} container>
            {projects.map(project => (
              <Grid lg={6} md={8} sm={12} xs={24} key={project.id}>
                <ProjectCard project={project} />
              </Grid>
            ))}
          </Grid>

          {loadingMore && (
            <Box display="flex" alignItems="center" justifyContent="center" py={3}>
              <CircularProgress size="sm" sx={{ mr: 1 }} />
              <Typography level="body-sm" color="neutral">
                Loading more projects...
              </Typography>
            </Box>
          )}
        </>
      )}
    </Box>
  );
};

const PAGE_PADDING = '40px';

const ProjectsPage = () => {
  const [search, setSearch] = useState('');
  const { data, isLoading, hasNextPage, fetchNextPage, isFetching } = useSearchProjects(
    search,
    { favorite: false },
    { by: 'createdAt', direction: 'desc' },
    { enabled: true } // Always enabled, non-blocking
  );
  const flattenProjects = data?.pages?.map(page => page.data).flat() ?? [];

  useDocumentTitle('Projects');

  // Auto-fetch next batch after initial load for progressive loading
  useEffect(() => {
    if (!isLoading && hasNextPage && flattenProjects.length > 0 && flattenProjects.length < 20) {
      const timer = setTimeout(() => {
        fetchNextPage();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isLoading, hasNextPage, flattenProjects.length, fetchNextPage]);

  const debounceScroll = useDetectScrollBottom(
    hasNextPage && !isFetching,
    useCallback(() => {
      fetchNextPage();
    }, [fetchNextPage])
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box
        sx={{
          px: PAGE_PADDING,
          pt: '20px',
          pb: '5px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '20px',
          flexWrap: 'wrap',
          flexDirection: {
            xs: 'column',
            sm: 'row',
          },
        }}
      >
        <Box display="flex" alignItems="center" gap={1}>
          <Box
            fontSize="24px"
            lineHeight="24px"
            sx={theme => ({ color: theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70' })}
          >
            Projects
          </Box>
          <ContextHelpButton helpId="features/projects" tooltipText="Learn about Projects" />
        </Box>
        <Box
          sx={{
            display: 'flex',
            gap: '15px',
            minWidth: {
              xs: '100%',
              sm: '400px',
              md: '500px',
            },
            flexDirection: {
              xs: 'column',
              sm: 'row',
            },
          }}
        >
          <SearchBar
            handleChange={setSearch}
            placeHolder="Search"
            debounceTimeout={300}
            endDecorator={isFetching ? <CircularProgress size="sm" /> : null}
          />
          <ProjectCreateModal />
        </Box>
      </Box>
      <Box
        display="flex"
        flexDirection="column"
        gap="40px"
        flexGrow={1}
        overflow="auto"
        px={PAGE_PADDING}
        pb={PAGE_PADDING}
        onScroll={debounceScroll}
      >
        <ProjectSection
          title=""
          projects={flattenProjects}
          loading={isLoading}
          loadingMore={isFetching && !isLoading}
        />
      </Box>
    </Box>
  );
};

export default ProjectsPage;
