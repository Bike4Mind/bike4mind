import { useState } from 'react';
import { Box, Button, Card, Chip, IconButton, Input, Modal, ModalDialog, Skeleton, Stack, Typography } from '@mui/joy';
import StorageIcon from '@mui/icons-material/Storage';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import PersonOutlineIcon from '@mui/icons-material/PersonOutline';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { useBrowsePublicDataLakes } from '@client/app/hooks/data/dataLakes';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { formatBytes } from '@client/app/utils/folderTreeParser';
import DataLakeViewer from './DataLakeViewer';

const PAGE_SIZE = 24;

/**
 * Discover surface: browse public data lakes shared by anyone across the app. Read-only -
 * a public lake's knowledge is already retrievable once published, so there is no subscribe
 * step; opening a card just previews the lake's files via the shared read-only DataLakeViewer.
 * Search matches name/description; "Load more" grows the page rather than paging by cursor.
 */
export default function DataLakeDiscoverPanel() {
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('', 300);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [viewingLake, setViewingLake] = useState<{ id: string; name: string; tagPrefix: string } | null>(null);

  const { data, isLoading, isFetching, isError } = useBrowsePublicDataLakes(debouncedSearch, limit);
  const lakes = data?.data ?? [];
  const total = data?.total ?? 0;
  const hasMore = lakes.length < total;

  return (
    <Box data-testid="datalake-discover-panel">
      <Input
        size="sm"
        placeholder="Search public data lakes"
        value={search}
        onChange={e => {
          setSearch(e.target.value);
          setLimit(PAGE_SIZE); // a new query resets the page growth
        }}
        startDecorator={<SearchIcon sx={{ fontSize: 18 }} />}
        endDecorator={
          search ? (
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="Clear search"
              data-testid="datalake-discover-clear"
              onClick={() => {
                setSearch('');
                setLimit(PAGE_SIZE);
              }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          ) : null
        }
        data-testid="datalake-discover-search"
        sx={{ mb: 2 }}
      />

      {isError ? (
        <Box sx={{ textAlign: 'center', py: 4 }} data-testid="datalake-discover-error">
          <Typography level="body-sm" color="danger">
            Couldn’t load public data lakes. Try again in a moment.
          </Typography>
        </Box>
      ) : isLoading ? (
        <Stack gap={1}>
          {[1, 2, 3].map(i => (
            <Skeleton key={i} variant="rectangular" height={84} sx={{ borderRadius: 'md' }} />
          ))}
        </Stack>
      ) : lakes.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 4 }} data-testid="datalake-discover-empty">
          <StorageIcon sx={{ fontSize: 40, opacity: 0.3, mb: 1 }} />
          <Typography level="body-sm" color="neutral">
            {debouncedSearch
              ? `No public data lakes match "${debouncedSearch}".`
              : 'No public data lakes yet. Once someone makes a lake public, it shows up here.'}
          </Typography>
        </Box>
      ) : (
        <>
          <Typography level="body-xs" color="neutral" sx={{ mb: 1 }} data-testid="datalake-discover-count">
            Showing {lakes.length} of {total}
          </Typography>
          <Stack gap={1}>
            {lakes.map(lake => (
              <Card
                key={lake.id}
                variant="outlined"
                data-testid={`datalake-discover-card-${lake.id}`}
                sx={{ p: 1.5, cursor: 'pointer', '&:hover': { borderColor: 'primary.300' } }}
                onClick={() => setViewingLake({ id: lake.id, name: lake.name, tagPrefix: lake.fileTagPrefix })}
              >
                <Stack direction="row" alignItems="flex-start" gap={1.5}>
                  <StorageIcon sx={{ fontSize: 20, color: 'primary.400', mt: 0.25 }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Stack direction="row" alignItems="center" gap={0.75}>
                      <Typography level="title-sm" noWrap>
                        {lake.name}
                      </Typography>
                      {lake.isOwn && (
                        <Chip size="sm" variant="soft" color="success" sx={{ fontSize: '10px' }}>
                          Owned by you
                        </Chip>
                      )}
                    </Stack>
                    {lake.description && (
                      <Typography
                        level="body-xs"
                        color="neutral"
                        sx={{
                          mt: 0.25,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {lake.description}
                      </Typography>
                    )}
                    <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
                      <Chip size="sm" variant="soft" color="neutral" sx={{ fontSize: '10px' }}>
                        {lake.fileTagPrefix}
                      </Chip>
                      {lake.ownerDisplayName && !lake.isOwn && (
                        <Chip
                          size="sm"
                          variant="plain"
                          color="neutral"
                          startDecorator={<PersonOutlineIcon sx={{ fontSize: 12 }} />}
                          sx={{ fontSize: '10px' }}
                        >
                          {lake.ownerDisplayName}
                        </Chip>
                      )}
                      <Chip
                        size="sm"
                        variant="plain"
                        color="neutral"
                        startDecorator={<DescriptionOutlinedIcon sx={{ fontSize: 12 }} />}
                        sx={{ fontSize: '10px' }}
                      >
                        {lake.fileCount} {lake.fileCount === 1 ? 'file' : 'files'} - {formatBytes(lake.totalSizeBytes)}
                      </Chip>
                    </Stack>
                  </Box>
                </Stack>
              </Card>
            ))}
          </Stack>

          {hasMore && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              fullWidth
              loading={isFetching}
              onClick={() => setLimit(l => l + PAGE_SIZE)}
              data-testid="datalake-discover-load-more"
              sx={{ mt: 1 }}
            >
              Load more
            </Button>
          )}
        </>
      )}

      {/* Read-only preview: canManage is never passed, so no management affordances render. */}
      <Modal open={!!viewingLake} onClose={() => setViewingLake(null)}>
        <ModalDialog
          sx={{
            width: { xs: '95%', md: '80%', lg: '72rem' },
            maxWidth: '72rem',
            height: '80vh',
            p: 0,
            overflow: 'hidden',
          }}
        >
          {viewingLake && (
            <DataLakeViewer
              dataLakeId={viewingLake.id}
              dataLakeName={viewingLake.name}
              tagPrefix={viewingLake.tagPrefix}
              canManage={false}
              onClose={() => setViewingLake(null)}
            />
          )}
        </ModalDialog>
      </Modal>
    </Box>
  );
}
