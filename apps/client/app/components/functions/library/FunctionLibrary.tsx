import React, { useMemo } from 'react';
import { Link as RouterLink } from '@tanstack/react-router';
import {
  Alert,
  Box,
  Chip,
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
import { CALLABLE_FUNCTION_TRUST_LABEL_TEXT, type CallableFunctionSharedStatus } from '@bike4mind/common';
import {
  useCallableFunctionList,
  useCallableFunctionsEnabled,
  useSharedCallableFunctions,
} from '@client/app/hooks/data/callableFunctions';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { groupFunctionLibrary, type FunctionLibraryRow, type FunctionLibraryState } from './libraryGrouping';

const STATE: Record<FunctionLibraryState, { label: string; color: 'success' | 'neutral' | 'warning' }> = {
  live: { label: 'Live', color: 'success' },
  draft: { label: 'Draft', color: 'warning' },
  off: { label: 'Off', color: 'neutral' },
};

export const REVIEW_TEXT: Record<CallableFunctionSharedStatus, string> = {
  pending_review: 'Pending review',
  reviewed: 'Reviewed',
  disabled: 'Turned off',
};

/** The label's first word on the chip; the whole sentence is its title. */
export function TrustLabelChip({ label }: { label: FunctionLibraryRow['trustLabel'] }) {
  if (!label) return null;
  const text = CALLABLE_FUNCTION_TRUST_LABEL_TEXT[label];
  return (
    <Chip
      size="sm"
      variant="soft"
      color={label === 'unverified' ? 'neutral' : 'success'}
      title={text}
      data-testid="function-library-trust-chip"
    >
      {text.split(':')[0]}
    </Chip>
  );
}

function LibraryRow({ row }: { row: FunctionLibraryRow }) {
  const state = STATE[row.state];
  return (
    <ListItem>
      <ListItemButton
        component={RouterLink}
        to={`/functions/${row.id}`}
        data-testid="function-library-row"
        sx={{ borderRadius: 'sm' }}
      >
        <ListItemContent>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography level="title-sm" sx={{ fontFamily: 'code' }}>
              {row.slug}
            </Typography>
            <Chip size="sm" variant="outlined" color={state.color} data-testid="function-library-state">
              {state.label}
            </Chip>
            <TrustLabelChip label={row.trustLabel} />
            {row.review && (
              <Chip size="sm" variant="soft" data-testid="function-library-review">
                {REVIEW_TEXT[row.review]}
              </Chip>
            )}
          </Stack>
          <Typography level="body-sm" sx={{ mt: 0.25 }}>
            {row.description}
          </Typography>
          {row.ownerName && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="function-library-owner">
              By {row.ownerName}
            </Typography>
          )}
        </ListItemContent>
      </ListItemButton>
    </ListItem>
  );
}

/** The person's own functions and those shared with them, searchable by name and description. */
export const FunctionLibrary: React.FC = () => {
  const enabled = useCallableFunctionsEnabled();
  const mine = useCallableFunctionList(enabled);
  const shared = useSharedCallableFunctions(enabled);
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('', 200);

  const groups = useMemo(
    () => groupFunctionLibrary({ mine: mine.data ?? [], shared: shared.data ?? [] }, debouncedSearch),
    [mine.data, shared.data, debouncedSearch]
  );

  if (!enabled) {
    return (
      <Typography level="body-md" textColor="text.tertiary" data-testid="function-library-off">
        Callable functions are not turned on for your account.
      </Typography>
    );
  }

  return (
    <Stack spacing={2} data-testid="function-library">
      <Input
        placeholder="Search functions"
        startDecorator={<SearchIcon />}
        value={search}
        onChange={event => setSearch(event.target.value)}
        sx={{ maxWidth: 360 }}
        slotProps={{ input: { 'data-testid': 'function-library-search-input', 'aria-label': 'Search functions' } }}
      />
      {mine.isPending || shared.isPending ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size="sm" data-testid="function-library-loading" />
        </Box>
      ) : mine.error || shared.error ? (
        <Alert color="danger" data-testid="function-library-error">
          Could not load your functions.
        </Alert>
      ) : (
        groups.map(group => (
          <Stack key={group.key} spacing={0.5} data-testid={`function-library-group-${group.key}`}>
            <Typography level="title-md">
              {group.title}
              {group.rows.length > 0 ? ` (${group.rows.length})` : ''}
            </Typography>
            {group.rows.length === 0 ? (
              <Typography level="body-sm" textColor="text.tertiary" data-testid="function-library-empty">
                {group.empty}
              </Typography>
            ) : (
              <List sx={{ '--ListItem-paddingY': '0.5rem' }}>
                {group.rows.map(row => (
                  <LibraryRow key={row.id} row={row} />
                ))}
              </List>
            )}
          </Stack>
        ))
      )}
    </Stack>
  );
};
