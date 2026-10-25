import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
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
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import type { ChatArtifactSummary, ChatArtifactView } from '@shared/chat';
import { ArtifactCard } from './ArtifactCard';
import { ArtifactThumbnail, useNearViewport } from './ArtifactThumbnail';
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
import { ArrowLeftIcon, CloseIcon, SearchIcon } from './icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from './layout';

/** What one card knows about its body: in flight, here, or refused. Absent means never asked for. */
type CardBody =
  { state: 'loading' } | { state: 'ready'; artifact: ChatArtifactView } | { state: 'error'; error: string };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load this artifact.';
}

/** Wider than the conversation's reading column: a grid of pictures is not a line of prose. */
const LIBRARY_MAX_WIDTH = 1120;
const libraryColumnSx = { ...contentColumnSx, maxWidth: LIBRARY_MAX_WIDTH };

/** Bodies fetched at once for thumbnails. A full page is 100 rows; this keeps a fast scroll from firing them all. */
const MAX_THUMBNAIL_READS = 4;

interface ArtifactTileProps {
  summary: ChatArtifactSummary;
  body: CardBody | undefined;
  mode: 'light' | 'dark';
  onOpen: (id: string) => void;
  onNear: (id: string, near: boolean) => void;
  scroller: RefObject<HTMLDivElement | null>;
}

/**
 * One artifact as a card: a thumbnail of the thing itself over its title, type and date. Memoized
 * because typing in the search re-renders the panel on every key, and a card whose props did not
 * change has nothing new to draw.
 */
const ArtifactTile = memo(function ArtifactTile({ summary, body, mode, onOpen, onNear, scroller }: ArtifactTileProps) {
  const root = useRef<HTMLButtonElement>(null);
  const near = useNearViewport(root, scroller);
  const avatar = avatarColors(summary.id, mode);
  const date = shortDate(summary.createdAt);

  useEffect(() => {
    onNear(summary.id, near);
  }, [near, onNear, summary.id]);
  // A card filtered out while waiting its turn gives the turn up.
  useEffect(() => () => onNear(summary.id, false), [onNear, summary.id]);

  // A page preview is a live document, so it only runs near the viewport; a picture or a snippet
  // costs nothing to keep once drawn.
  const thumbnail = body?.state === 'ready' && (near || body.artifact.type !== 'html') ? body.artifact : null;

  return (
    <Box
      component="button"
      type="button"
      ref={root}
      onClick={() => onOpen(summary.id)}
      data-testid="artifact-library-card"
      data-artifact-id={summary.id}
      sx={theme => ({
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        p: 0,
        m: 0,
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        overflow: 'hidden',
        borderRadius: 'md',
        border: '1px solid',
        borderColor: 'neutral.outlinedBorder',
        bgcolor: 'background.surface',
        transition: 'border-color 120ms',
        '&:hover': { borderColor: 'neutral.outlinedHoverBorder' },
        [theme.focus.selector]: theme.focus.default,
      })}
    >
      <Box
        aria-hidden="true"
        sx={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 10',
          overflow: 'hidden',
          bgcolor: 'background.level1',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
        data-testid="artifact-library-card-thumb"
        data-state={thumbnail ? 'ready' : (body?.state ?? 'idle')}
      >
        {thumbnail ? (
          <ArtifactThumbnail artifact={thumbnail} mode={mode} />
        ) : (
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: 'md',
                display: 'grid',
                placeItems: 'center',
                bgcolor: avatar.background,
                color: avatar.color,
                fontSize: 17,
                fontWeight: 600,
                userSelect: 'none',
              }}
              data-testid="artifact-library-card-avatar"
            >
              {initialOf(summary.title)}
            </Box>
          </Box>
        )}
      </Box>
      <Box sx={{ px: 1.25, pt: 1, pb: 1.25, minWidth: 0, width: '100%' }}>
        <Typography level="title-sm" noWrap title={summary.title} data-testid="artifact-library-card-title">
          {summary.title}
        </Typography>
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5, minWidth: 0 }}>
          <Chip size="sm" variant="soft" color="neutral" data-testid="artifact-library-card-type">
            {typeLabel(summary.type)}
          </Chip>
          {date && (
            <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="artifact-library-card-date">
              {date}
            </Typography>
          )}
        </Stack>
      </Box>
    </Box>
  );
});

/**
 * One artifact opened to fill the panel. The same card the transcript draws, so an artifact is
 * isolated the same way wherever it is met, told to take every pixel it is given.
 */
function ArtifactDetail({
  summary,
  body,
  onBack,
  onClose,
  onRetry,
}: {
  summary: ChatArtifactSummary;
  body: CardBody | undefined;
  onBack: () => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const back = useRef<HTMLButtonElement>(null);
  const date = shortDate(summary.createdAt);

  useEffect(() => {
    back.current?.focus();
  }, []);

  return (
    <Stack sx={{ flex: 1, minHeight: 0 }} data-testid="artifact-library-detail">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 3, py: 1.25 }}>
          <IconButton
            ref={back}
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Back to all artifacts"
            onClick={onBack}
            data-testid="artifact-library-detail-back-btn"
          >
            <ArrowLeftIcon />
          </IconButton>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-md" noWrap title={summary.title} data-testid="artifact-library-detail-title">
              {summary.title}
            </Typography>
            {summary.description && (
              <Typography
                level="body-xs"
                textColor="text.tertiary"
                noWrap
                title={summary.description}
                data-testid="artifact-library-detail-description"
              >
                {summary.description}
              </Typography>
            )}
          </Box>
          <Chip size="sm" variant="soft" color="neutral">
            {typeLabel(summary.type)}
          </Chip>
          {date && (
            <Typography level="body-xs" textColor="text.tertiary" noWrap>
              {date}
            </Typography>
          )}
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Close artifacts"
            onClick={onClose}
            data-testid="artifact-library-detail-close-btn"
          >
            <CloseIcon />
          </IconButton>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', px: 3, py: 2 }}>
        {(!body || body.state === 'loading') && (
          <Stack direction="row" spacing={1} alignItems="center" data-testid="artifact-library-detail-loading">
            <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />
            <Typography level="body-xs" textColor="text.tertiary">
              Loading...
            </Typography>
          </Stack>
        )}
        {body?.state === 'error' && (
          <Alert
            size="sm"
            color="danger"
            variant="soft"
            endDecorator={
              <Button
                size="sm"
                variant="soft"
                color="danger"
                onClick={onRetry}
                data-testid="artifact-library-detail-retry-btn"
              >
                Try again
              </Button>
            }
            data-testid="artifact-library-detail-error"
          >
            {body.error}
          </Alert>
        )}
        {body?.state === 'ready' && <ArtifactCard key={summary.id} artifact={body.artifact} fill />}
      </Box>
    </Stack>
  );
}

/**
 * Every artifact this account has made from a desktop client, presented like the web app's Live
 * Artifacts list (PublishedArtifactsTabContent) but holding only what the list route returns.
 *
 * The SERVER's list, not a walk of the local sessions: an artifact is posted as it is made, so
 * the server holds the union across machines and the current body after any web-app edit. That
 * is also why this can fail in ways a local list could not, and why being signed out is a
 * message here rather than an empty panel.
 *
 * Bodies are fetched per card as it nears the viewport, never up front. The list route returns
 * artifact documents without their bodies - those live in their own collection - so drawing every
 * thumbnail at once would pull every HTML file this account owns across the wire before the user
 * scrolled to any of them. Body state lives here rather than in the cards so a card filtered out
 * and back in, or one opened and closed again, keeps what it fetched.
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
  const [bodies, setBodies] = useState<Readonly<Record<string, CardBody>>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  // Mirror of `bodies` for the loader, which must stay referentially stable for the memoized
  // cards and so cannot close over the state itself.
  const bodiesRef = useRef(bodies);
  const grid = useRef<HTMLDivElement>(null);
  const lastOpened = useRef<string | null>(null);

  const setBody = useCallback((id: string, body: CardBody) => {
    bodiesRef.current = { ...bodiesRef.current, [id]: body };
    setBodies(bodiesRef.current);
  }, []);

  // A queue rather than a read per card: thumbnails are wanted as cards scroll into view, and one
  // that scrolls out again before its turn is dropped instead of fetched for nobody.
  const loader = useMemo(() => {
    const queue: string[] = [];
    const nearIds = new Set<string>();
    let generation = 0;
    let inFlight = 0;
    const start = (id: string) => {
      const requestedGeneration = generation;
      inFlight += 1;
      setBody(id, { state: 'loading' });
      void window.b4m.chat
        .readArtifact(id)
        .then(
          result => {
            if (requestedGeneration !== generation) return;
            setBody(
              id,
              result.artifact
                ? { state: 'ready', artifact: result.artifact }
                : { state: 'error', error: result.error ?? 'Could not load this artifact.' }
            );
          },
          (cause: unknown) => {
            if (requestedGeneration === generation) setBody(id, { state: 'error', error: describe(cause) });
          }
        )
        .finally(() => {
          inFlight -= 1;
          pump();
        });
    };
    const pump = () => {
      while (inFlight < MAX_THUMBNAIL_READS && queue.length > 0) {
        const next = queue.shift();
        if (next) start(next);
      }
    };
    const drop = (id: string) => {
      const at = queue.indexOf(id);
      if (at >= 0) queue.splice(at, 1);
    };
    return {
      // A failed thumbnail is not retried from scrolling; opening the card is the retry.
      near: (id: string, near: boolean) => {
        if (!near) {
          nearIds.delete(id);
          return drop(id);
        }
        nearIds.add(id);
        if (bodiesRef.current[id] || queue.includes(id)) return;
        queue.push(id);
        pump();
      },
      // A successful refresh invalidates bodies too: web edits retain the same artifact id.
      // Keep old reads counted until they settle, but never let their results refill this cache.
      refresh: (summaries: readonly ChatArtifactSummary[], openedId: string | null) => {
        generation += 1;
        queue.length = 0;
        bodiesRef.current = {};
        setBodies(bodiesRef.current);
        for (const summary of summaries) {
          if (nearIds.has(summary.id)) queue.push(summary.id);
        }
        if (openedId !== null && summaries.some(summary => summary.id === openedId)) {
          drop(openedId);
          start(openedId);
        }
        pump();
      },
      // Opening skips the queue: the user is waiting on this one.
      now: (id: string) => {
        const state = bodiesRef.current[id]?.state;
        if (state === 'loading' || state === 'ready') return;
        drop(id);
        start(id);
      },
    };
  }, [setBody]);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await window.b4m.chat.listArtifacts();
    if (!result.error) {
      loader.refresh(result.artifacts, lastOpened.current);
      setSummaries(result.artifacts);
      setTotal(result.total);
    }
    setError(result.error ?? null);
    setLoading(false);
  }, [loader]);

  useEffect(() => {
    void load();
  }, [load]);

  const openArtifact = useCallback(
    (id: string) => {
      setOpenId(id);
      loader.now(id);
    },
    [loader]
  );

  const closeArtifact = useCallback(() => setOpenId(null), []);

  const opened = openId === null ? undefined : summaries?.find(summary => summary.id === openId);
  const openedId = opened?.id ?? null;

  useLayoutEffect(() => {
    const previous = lastOpened.current;
    lastOpened.current = openedId;
    if (openedId !== null || previous === null) return;
    [...(grid.current?.querySelectorAll<HTMLElement>('[data-artifact-id]') ?? [])]
      .find(card => card.dataset.artifactId === previous)
      ?.focus({ preventScroll: true });
  }, [openedId]);

  useEffect(() => {
    if (openedId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeArtifact();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openedId, closeArtifact]);

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
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx, position: 'relative' }} data-testid="artifact-library">
      {opened && (
        <Stack sx={{ position: 'absolute', inset: 0, zIndex: 1, bgcolor: 'background.body' }}>
          <ArtifactDetail
            summary={opened}
            body={bodies[opened.id]}
            onBack={closeArtifact}
            onClose={onClose}
            onRetry={() => loader.now(opened.id)}
          />
        </Stack>
      )}
      {/* Hidden rather than unmounted under an opened artifact: going back then costs nothing, keeps
          its scroll, and does not reload every live page thumbnail. `visibility` and not `display`,
          which would read as off screen to the observers and drop those thumbnails anyway. */}
      <Stack
        inert={Boolean(opened)}
        sx={{ flex: 1, minHeight: 0, visibility: opened ? 'hidden' : undefined }}
        data-testid="artifact-library-browse"
      >
        <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', position: 'relative' }}>
          <Box sx={{ ...libraryColumnSx, pt: 1.25, pb: 1.5 }}>
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
              Everything you have made in this app, across your machines. Open one to view it or share it as a live
              link.
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

        <Box ref={grid} sx={{ flex: 1, ...scrollingColumnHostSx }} data-testid="artifact-library-grid-scroller">
          <Box sx={{ ...libraryColumnSx, py: 2 }}>
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
              <Box
                sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 1.5 }}
                data-testid="artifact-library-grid"
              >
                {visible.map(summary => (
                  <ArtifactTile
                    key={summary.id}
                    summary={summary}
                    body={bodies[summary.id]}
                    mode={mode}
                    onOpen={openArtifact}
                    onNear={loader.near}
                    scroller={grid}
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
    </Stack>
  );
}
