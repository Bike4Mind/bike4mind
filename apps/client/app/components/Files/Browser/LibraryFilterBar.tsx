import { useGenerationModelIds } from '@client/app/hooks/data/fileStars';
import type { ISearchFabFilesParams } from '@client/app/hooks/data/fabFileSearch';
import LockIcon from '@mui/icons-material/Lock';
import StarIcon from '@mui/icons-material/Star';
import { Button, Chip, Option, Select, Stack } from '@mui/joy';
import { FC } from 'react';
import { FileBrowserFilters, isFilterLocked, lockedFilterLabels } from './browserFilters';

const ALL_MODELS = 'all';

type LibraryFilterBarProps = {
  value: ISearchFabFilesParams;
  onChange: (params: ISearchFabFilesParams) => void;
  lockedFilters?: FileBrowserFilters;
  showModelFilter?: boolean;
  showStarredFilter?: boolean;
};

/**
 * The file browser's extra filter row: the caller's locked filters as chips the user cannot remove, then the
 * optional model and starred filters. A filter that is locked gets a chip instead of a control.
 */
const LibraryFilterBar: FC<LibraryFilterBarProps> = ({
  value,
  onChange,
  lockedFilters,
  showModelFilter = false,
  showStarredFilter = false,
}) => {
  // A filter the user holds (e.g. from initialFilters) always gets its control, so it can be cleared.
  const withModel = (showModelFilter || Boolean(value.filters?.model)) && !isFilterLocked(lockedFilters, 'model');
  const withStarred =
    (showStarredFilter || value.filters?.starred === true) && !isFilterLocked(lockedFilters, 'starred');
  const { data: modelIds = [] } = useGenerationModelIds({ enabled: withModel });
  const starred = value.filters?.starred === true;

  const setFilter = (patch: NonNullable<ISearchFabFilesParams['filters']>) =>
    onChange({ ...value, filters: { ...value.filters, ...patch } });

  return (
    <Stack
      data-testid="file-browser-library-filters"
      direction="row"
      gap={1}
      sx={{ alignItems: 'center', flexWrap: 'wrap' }}
    >
      {lockedFilterLabels(lockedFilters).map(({ key, label }) => (
        <Chip
          key={key}
          data-testid={`file-browser-locked-filter-chip-${key}`}
          size="sm"
          variant="soft"
          color="primary"
          startDecorator={<LockIcon sx={{ fontSize: 12 }} />}
        >
          {label}
        </Chip>
      ))}
      {withModel && (
        <Select
          data-testid="file-browser-model-filter-select"
          size="sm"
          value={value.filters?.model ?? ALL_MODELS}
          onChange={(_, model) => setFilter({ model: model && model !== ALL_MODELS ? model : undefined })}
          sx={{ minWidth: 180 }}
        >
          <Option value={ALL_MODELS}>All models</Option>
          {modelIds.map(modelId => (
            <Option key={modelId} value={modelId}>
              {modelId}
            </Option>
          ))}
        </Select>
      )}
      {withStarred && (
        <Button
          data-testid="file-browser-starred-filter-btn"
          size="sm"
          aria-pressed={starred}
          variant={starred ? 'solid' : 'outlined'}
          color={starred ? 'primary' : 'neutral'}
          startDecorator={<StarIcon />}
          onClick={() => setFilter({ starred: starred ? undefined : true })}
        >
          Starred
        </Button>
      )}
    </Stack>
  );
};

export default LibraryFilterBar;
