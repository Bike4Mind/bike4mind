import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import LinearProgress from '@mui/joy/LinearProgress';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import type { ChatArtifactSummary, ChatArtifactView } from '@shared/chat';
import { ArtifactCard } from './ArtifactCard';
import {
  ARTIFACT_SORTS,
  type ArtifactSort,
  avatarColors,
  countTypes,
  indexArtifacts,
  initialOf,
  selectArtifacts,
  shortDate,
  typeLabel,
} from './artifactLibrary';
import { CloseIcon, DisclosureIcon, SearchIcon } from './icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';

/** What one row knows about its body: in flight, here, or refused. Absent means never asked for. */
type RowBody =
  { state: 'loading' } | { state: 'ready'; artifact: ChatArtifactView } | { state: 'error'; error: string };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load this artifact.';
}

interface ArtifactRowProps {
  summary: ChatArtifactSummary;
  open: boolean;
  body: RowBody | undefined;
  mode: 'light' | 'dark';
  onToggle: (id: string) => void;
}

/**
 * One artifact: a single-line summary, laid out after the web app's artifact list, that shows its
 * body when opened. Memoized because typing in the search re-renders the panel on every key, and
 * a row whose props did not change has nothing new to draw.
 */
const ArtifactRow = memo(function ArtifactRow({ summary, open, body, mode, onToggle }: ArtifactRowProps) {
  const avatar = avatarColors(summary.id, mode);
  const date = shortDate(summary.createdAt);

  return (
    <Sheet
      variant="outlined"
      sx={{ p: 1, borderRadius: 'md', display: 'flex', flexDirection: 'column', gap: 0.75 }}
      data-testid="artifact-library-row"
    >
      <Box
        onClick={() => onToggle(summary.id)}
        sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, cursor: 'pointer' }}
        data-testid="artifact-library-row-summary"
      >
        <Box
          aria-hidden="true"
          sx={{
            width: 26,
            height: 26,
            flex: 'none',
            borderRadius: 'sm',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: avatar.background,
            color: avatar.color,
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1,
            userSelect: 'none',
          }}
          data-testid="artifact-library-row-avatar"
        >
          {initialOf(summary.title)}
        </Box>
        <Typography
          level="title-sm"
          color="primary"
          noWrap
          title={summary.title}
          sx={{ minWidth: 0, flex: '0 1 auto', '&:hover': { textDecoration: 'underline' } }}
          data-testid="artifact-library-row-title"
        >
          {summary.title}
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'nowrap', ml: 'auto', flex: 'none' }}>
          {date && (
            <Typography
              level="body-xs"
              sx={{ opacity: 0.6, whiteSpace: 'nowrap' }}
              data-testid="artifact-library-row-date"
            >
              {date}
            </Typography>
          )}
          <Chip size="sm" variant="soft" color="neutral" data-testid="artifact-library-row-type">
            {typeLabel(summary.type)}
          </Chip>
          {/* No handler of its own: the click bubbles to the row, so the row and the button are
              one toggle and a click on the button cannot flip it twice. */}
          <IconButton
            size="sm"
            variant={open ? 'soft' : 'plain'}
            color="neutral"
            aria-expanded={open}
            aria-label={open ? 'Hide artifact' : 'Show artifact'}
            data-testid="artifact-library-row-expand-btn"
          >
            <DisclosureIcon open={open} />
          </IconButton>
        </Box>
      </Box>

      {open && (
        <Box data-testid="artifact-library-row-detail">
          {summary.description && (
            <Typography level="body-xs" sx={{ opacity: 0.7, mb: 0.75 }} data-testid="artifact-library-row-description">
              {summary.description}
            </Typography>
          )}
          {body?.state === 'loading' && (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ py: 1 }}
              data-testid="artifact-library-row-loading"
            >
              <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />
              <Typography level="body-xs" textColor="text.tertiary">
                Loading...
              </Typography>
            </Stack>
          )}
          {body?.state === 'error' && (
            <Alert size="sm" color="danger" variant="soft" data-testid="artifact-library-row-error">
              {body.error}
            </Alert>
          )}
          {/* The same card the transcript draws, so an artifact looks the same wherever it is
              met - and, more to the point, is isolated the same way. */}
          {body?.state === 'ready' && <ArtifactCard artifact={body.artifact} />}
        </Box>
      )}
    </Sheet>
  );
});

/**
 * Every artifact this account has made from a desktop client, presented like the web app's Live
 * Artifacts list (PublishedArtifactsTabContent) but holding only what the list route returns.
 *
 * The SERVER's list, not a walk of the local sessions: an artifact is posted as it is made, so
 * the server holds the union across machines and the current body after any web-app edit. That
 * is also why this can fail in ways a local list could not, and why being signed out is a
 * message here rather than an empty panel.
 *
 * Bodies are fetched per row on open, never up front. The list route returns artifact documents
 * without their bodies - those live in their own collection - so drawing every body would pull
 * every HTML file this account owns across the wire to show a list of titles. Open and body state
 * live here rather than in the rows so a row filtered out and back in keeps what it fetched.
 */
export function ArtifactLibraryPanel({ onClose }: { onClose: () => void }) {
  const mode = useTheme().palette.mode === 'dark' ? 'dark' : 'light';
  const [summaries, setSummaries] = useState<ChatArtifactSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [sort, setSort] = useState<ArtifactSort>('newest');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [bodies, setBodies] = useState<Readonly<Record<string, RowBody>>>({});
  // Mirrors of the two maps above for onToggle, which must stay referentially stable for the
  // memoized rows and so cannot close over the state itself.
  const expandedRef = useRef(expanded);
  const bodiesRef = useRef(bodies);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await window.b4m.chat.listArtifacts();
    setSummaries(result.artifacts);
    setTotal(result.total);
    setError(result.error ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setBody = useCallback((id: string, body: RowBody) => {
    bodiesRef.current = { ...bodiesRef.current, [id]: body };
    setBodies(bodiesRef.current);
  }, []);

  // Fetched from the click rather than from an effect on `expanded`: opening IS the event, and an
  // effect keyed on the body it writes would re-run, and cancel, the read it just started.
  const onToggle = useCallback(
    (id: string) => {
      const next = new Set(expandedRef.current);
      const opening = !next.delete(id);
      if (opening) next.add(id);
      expandedRef.current = next;
      setExpanded(next);

      const current = bodiesRef.current[id]?.state;
      if (!opening || current === 'loading' || current === 'ready') return;
      setBody(id, { state: 'loading' });
      void window.b4m.chat.readArtifact(id).then(
        result =>
          setBody(
            id,
            result.artifact
              ? { state: 'ready', artifact: result.artifact }
              : { state: 'error', error: result.error ?? 'Could not load this artifact.' }
          ),
        (cause: unknown) => setBody(id, { state: 'error', error: describe(cause) })
      );
    },
    [setBody]
  );

  // Deferred so a keystroke paints the input first and the list catches up, which keeps typing
  // smooth at a full page of rows without a debounce timer to manage.
  const deferredQuery = useDeferredValue(query);
  const indexed = useMemo(() => indexArtifacts(summaries ?? []), [summaries]);
  // The selected type keeps its chip even after a refresh drops its last row, so the filter can
  // still be turned off where it was turned on.
  const typeCounts = useMemo(() => {
    const counts = countTypes(indexed);
    return type === null || counts.some(entry => entry.type === type)
      ? counts
      : [...counts, { type, label: typeLabel(type), count: 0 }];
  }, [indexed, type]);
  const visible = useMemo(
    () => selectArtifacts(indexed, { query: deferredQuery, type, sort }),
    [indexed, deferredQuery, type, sort]
  );

  const loaded = summaries?.length ?? 0;
  const filtering = Boolean(query.trim()) || type !== null;
  const empty = !loading && !error && summaries?.length === 0;
  const clearFilters = () => {
    setQuery('');
    setType(null);
  };

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="artifact-library">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', position: 'relative' }}>
        <Box sx={{ ...contentColumnSx, pt: 1.25, pb: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography level="title-md" sx={{ flex: 1 }}>
              Artifacts
            </Typography>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => void load()}
              disabled={loading}
              data-testid="artifact-library-refresh-btn"
            >
              Refresh
            </Button>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="Close artifacts"
              onClick={onClose}
              data-testid="artifact-library-close-btn"
            >
              <CloseIcon />
            </IconButton>
          </Stack>
          <Typography level="body-sm" sx={{ mt: 0.5, opacity: 0.8 }}>
            Everything you have made in this app, across your machines. Open one to view it or share it as a live link.
          </Typography>

          {/* Shown while there is something to narrow OR a filter is on, so the way out of a
              no-matches state is always on screen. */}
          {(loaded > 0 || filtering) && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1.5 }}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Input
                  size="sm"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="Search titles and descriptions"
                  startDecorator={<SearchIcon />}
                  slotProps={{
                    input: { 'data-testid': 'artifact-library-search-input', 'aria-label': 'Search artifacts' },
                  }}
                  sx={{ flex: 1, minWidth: 0 }}
                />
                <Select
                  size="sm"
                  value={sort}
                  onChange={(_event, value) => value && setSort(value)}
                  aria-label="Sort artifacts"
                  slotProps={{ button: { 'data-testid': 'artifact-library-sort-select' } }}
                  sx={{ minWidth: 140 }}
                >
                  {ARTIFACT_SORTS.map(option => (
                    <Option
                      key={option.value}
                      value={option.value}
                      data-testid={`artifact-library-sort-${option.value}`}
                    >
                      {option.label}
                    </Option>
                  ))}
                </Select>
                {filtering && (
                  <Button
                    size="sm"
                    variant="plain"
                    color="neutral"
                    onClick={clearFilters}
                    data-testid="artifact-library-clear-btn"
                  >
                    Clear
                  </Button>
                )}
              </Box>

              {typeCounts.length > 0 && (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
                  {typeCounts.map(({ type: chipType, label, count }) => {
                    const selected = type === chipType;
                    return (
                      <Chip
                        key={chipType}
                        size="sm"
                        variant={selected ? 'solid' : 'outlined'}
                        color={selected ? 'primary' : 'neutral'}
                        onClick={() => setType(selected ? null : chipType)}
                        slotProps={{
                          action: {
                            'aria-pressed': selected,
                            'data-testid': `artifact-library-filter-${chipType}-chip`,
                          },
                        }}
                      >
                        {label} {count}
                      </Chip>
                    );
                  })}
                </Box>
              )}
            </Box>
          )}
        </Box>
        {loading && summaries && (
          <LinearProgress
            size="sm"
            thickness={2}
            sx={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
            data-testid="artifact-library-refreshing"
          />
        )}
      </Box>

      <Box sx={{ flex: 1, ...scrollingColumnHostSx }}>
        <Box sx={{ ...contentColumnSx, py: 2 }}>
          {/* An error and a stale list can be on screen together: a refresh that fails leaves
              the rows it already had, which are still worth reading. */}
          {error && (
            <Alert
              size="sm"
              color="warning"
              variant="soft"
              sx={{ mb: 1.5 }}
              endDecorator={
                <Button
                  size="sm"
                  variant="soft"
                  color="warning"
                  onClick={() => void load()}
                  disabled={loading}
                  data-testid="artifact-library-retry-btn"
                >
                  Try again
                </Button>
              }
              data-testid="artifact-library-error"
            >
              {error}
            </Alert>
          )}

          {loading && !summaries && (
            <Box data-testid="artifact-library-loading">
              <LinearProgress size="sm" sx={{ mb: 1 }} />
              <Typography level="body-sm" sx={{ opacity: 0.7 }}>
                Loading artifacts...
              </Typography>
            </Box>
          )}

          {empty && (
            <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="artifact-library-empty">
              No artifacts yet. Ask for a page, a diagram or a file and it will appear here.
            </Typography>
          )}

          {loaded > 0 && visible.length === 0 && (
            <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="artifact-library-no-matches">
              Nothing matches those filters. Clear them to see every artifact.
            </Typography>
          )}

          {visible.length > 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {visible.map(summary => (
                <ArtifactRow
                  key={summary.id}
                  summary={summary}
                  open={expanded.has(summary.id)}
                  body={bodies[summary.id]}
                  mode={mode}
                  onToggle={onToggle}
                />
              ))}
            </Box>
          )}

          {/* The list route returns one page, so say so rather than let search and the counts
              read as covering rows that were never fetched. */}
          {total > loaded && loaded > 0 && (
            <Typography level="body-xs" sx={{ mt: 1.5, opacity: 0.7 }} data-testid="artifact-library-truncated">
              Showing your newest {loaded} of {total} artifacts. Search, filters and counts cover these {loaded}.
            </Typography>
          )}
        </Box>
      </Box>
    </Stack>
  );
}
