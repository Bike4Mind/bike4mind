import React, { useMemo } from 'react';
import { Link as RouterLink } from '@tanstack/react-router';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Input,
  List,
  ListItem,
  ListItemButton,
  ListItemContent,
  Stack,
  Typography,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import { useArtifactLibrary } from '@client/app/hooks/data/artifacts';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { ARTIFACT_SOURCE_LABEL, getArtifactSource } from './artifactSource';

const formatDate = (value: Date | string) => new Date(value).toLocaleDateString();

/** The signed-in user's artifacts: a searchable, paginated list where each row opens `/artifacts/$id`. */
export const ArtifactLibrary: React.FC = () => {
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('', 300);
  const { data, error, isPending, isFetchingNextPage, hasNextPage, fetchNextPage } = useArtifactLibrary({
    search: debouncedSearch.trim(),
  });

  // Offset paging over an updatedAt sort can return a row twice if it is edited between page loads.
  const artifacts = useMemo(() => {
    const seen = new Set<string>();
    return (data?.pages.flatMap(page => page.artifacts) ?? []).filter(artifact => {
      if (seen.has(artifact.id)) return false;
      seen.add(artifact.id);
      return true;
    });
  }, [data]);

  return (
    <Stack spacing={2} data-testid="artifact-library">
      <Input
        placeholder="Search artifacts"
        startDecorator={<SearchIcon />}
        value={search}
        onChange={event => setSearch(event.target.value)}
        sx={{ maxWidth: 360 }}
        slotProps={{ input: { 'data-testid': 'artifact-library-search-input', 'aria-label': 'Search artifacts' } }}
      />

      {isPending ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size="sm" data-testid="artifact-library-loading" />
        </Box>
      ) : error ? (
        <Alert color="danger" data-testid="artifact-library-error">
          Could not load your artifacts.
        </Alert>
      ) : artifacts.length === 0 ? (
        <Typography level="body-md" textColor="text.tertiary" sx={{ py: 4 }} data-testid="artifact-library-empty">
          {debouncedSearch.trim()
            ? 'No artifacts match your search.'
            : 'No artifacts yet. Artifacts you create in a notebook or through the API show up here.'}
        </Typography>
      ) : (
        <List sx={{ '--ListItem-paddingY': '0.625rem' }} data-testid="artifact-library-list">
          {artifacts.map(artifact => (
            <ListItem key={artifact.id}>
              <ListItemButton
                component={RouterLink}
                to={`/artifacts/${artifact.id}`}
                data-testid="artifact-library-item-link"
                sx={{ borderRadius: 'sm' }}
              >
                <ListItemContent>
                  <Typography level="title-sm" noWrap>
                    {artifact.title || 'Untitled artifact'}
                  </Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    {artifact.type} {'\u00b7'} {ARTIFACT_SOURCE_LABEL[getArtifactSource(artifact).kind]} {'\u00b7'}{' '}
                    Updated {formatDate(artifact.updatedAt)}
                  </Typography>
                </ListItemContent>
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      )}

      {hasNextPage && (
        <Box>
          <Button
            variant="outlined"
            color="neutral"
            loading={isFetchingNextPage}
            onClick={() => fetchNextPage()}
            data-testid="artifact-library-load-more-btn"
          >
            Load more
          </Button>
        </Box>
      )}
    </Stack>
  );
};

export default ArtifactLibrary;
