import { useEffect, useRef, useState, type ReactNode } from 'react';
import AspectRatio from '@mui/joy/AspectRatio';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Modal from '@mui/joy/Modal';
import ModalClose from '@mui/joy/ModalClose';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { LibraryApi, LibraryItem } from '@shared/library';
import { GridIcon, ImageIcon, PanelLeftIcon, ReloadIcon, VideoIcon } from '../icons';
import { thinScrollbarSx } from '../layout';
import { NavItem } from '../SessionList';
import type { LibraryFilter } from '../library/libraryFeed';
import { useLibraryFeed } from '../library/useLibraryFeed';
import { useLibraryMedia } from '../library/useLibraryMedia';

const FILTERS: readonly { filter: LibraryFilter; label: string; icon: ReactNode }[] = [
  { filter: 'all', label: 'All', icon: <GridIcon /> },
  { filter: 'image', label: 'Images', icon: <ImageIcon /> },
  { filter: 'video', label: 'Videos', icon: <VideoIcon /> },
];

const filterLabel = (filter: LibraryFilter) => FILTERS.find(entry => entry.filter === filter)?.label ?? filter;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const formatDate = (iso: string) => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '' : dateFormat.format(parsed);
};

/** The Library place's sidebar: the medium filter. */
export function LibrarySidebar({
  width,
  filter,
  onSelectFilter,
  onToggleCollapsed,
}: {
  width: number;
  filter: LibraryFilter;
  onSelectFilter: (filter: LibraryFilter) => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <Stack
      sx={{
        width,
        flexShrink: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
      }}
      data-testid="library-sidebar"
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, px: 1.5, pt: 1.5, pb: 1 }}>
        <Typography level="title-sm" sx={{ flex: 1, pl: 0.5 }} data-testid="sidebar-place-title">
          Library
        </Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Hide sidebar"
          onClick={onToggleCollapsed}
          data-testid="sidebar-toggle-btn"
        >
          <PanelLeftIcon />
        </IconButton>
      </Stack>
      <Stack spacing={0.25} sx={{ px: 1, pb: 1, overflowY: 'auto', ...thinScrollbarSx }}>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, pt: 0.5, pb: 0.25 }}>
          Generated media
        </Typography>
        {FILTERS.map(entry => (
          <Box
            key={entry.filter}
            sx={{ borderRadius: 'sm', bgcolor: filter === entry.filter ? 'neutral.softBg' : undefined }}
            aria-current={filter === entry.filter ? 'true' : undefined}
          >
            <NavItem
              icon={entry.icon}
              label={entry.label}
              onClick={() => onSelectFilter(entry.filter)}
              testId={`library-filter-${entry.filter}-btn`}
            />
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}

function CenteredState({
  title,
  body,
  action,
  testId,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <Stack
      spacing={0.75}
      sx={{ maxWidth: 420, mx: 'auto', mt: 12, px: 2, textAlign: 'center', alignItems: 'center' }}
      data-testid={testId}
    >
      <Typography level="title-md">{title}</Typography>
      {body && (
        <Typography level="body-sm" textColor="text.tertiary">
          {body}
        </Typography>
      )}
      {action && <Box sx={{ pt: 1 }}>{action}</Box>}
    </Stack>
  );
}

/** Turns true once the element is near the viewport, so a long grid only downloads what is seen. */
function useNearViewport<T extends Element>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!node || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, near]);
  return [setNode, near];
}

function TileFace({ item, api }: { item: LibraryItem; api: Pick<LibraryApi, 'media'> }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  // Videos are not downloaded for the grid: a clip can be tens of megabytes. They open on click.
  const wantsThumbnail = item.medium === 'image' && item.availability === 'ready';
  const media = useLibraryMedia(api, item, wantsThumbnail && near);
  let face: ReactNode;
  if (item.availability === 'pending_scan') {
    face = <Typography level="body-xs">Still being checked</Typography>;
  } else if (item.availability === 'unavailable') {
    face = <Typography level="body-xs">No longer available</Typography>;
  } else if (item.medium === 'video') {
    face = (
      <Stack alignItems="center" spacing={0.5}>
        <VideoIcon />
        {item.durationSeconds !== undefined && (
          <Typography level="body-xs">{`${Math.round(item.durationSeconds)}s video`}</Typography>
        )}
      </Stack>
    );
  } else if (media.status === 'ready') {
    face = (
      <img
        src={media.media.url}
        alt={item.prompt}
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        data-testid="library-tile-image"
      />
    );
  } else if (media.status === 'error') {
    face = <Typography level="body-xs">Could not load</Typography>;
  } else {
    face = <CircularProgress size="sm" />;
  }
  return (
    <AspectRatio ref={ref} ratio="1" variant="soft" sx={{ borderRadius: 'md', color: 'text.tertiary' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{face}</Box>
    </AspectRatio>
  );
}

function LibraryTile({
  item,
  api,
  onOpen,
}: {
  item: LibraryItem;
  api: Pick<LibraryApi, 'media'>;
  onOpen: (item: LibraryItem) => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onOpen(item)}
      title={item.prompt}
      sx={{
        all: 'unset',
        cursor: 'pointer',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        borderRadius: 'md',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: 2 },
        '&:hover .library-tile-caption': { color: 'text.primary' },
      }}
      data-testid={`library-tile-${item.medium}-${item.id}`}
    >
      <TileFace item={item} api={api} />
      <Typography level="body-xs" noWrap className="library-tile-caption" textColor="text.secondary">
        {item.prompt || 'Untitled'}
      </Typography>
    </Box>
  );
}

function LibraryViewer({
  item,
  api,
  onClose,
  onOpenSession,
}: {
  item: LibraryItem;
  api: Pick<LibraryApi, 'media' | 'locate'>;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const media = useLibraryMedia(api, item, item.availability === 'ready');
  const [session, setSession] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setSession(undefined);
    api.locate({ medium: item.medium, id: item.id }).then(
      found => live && setSession(found?.sessionId ?? null),
      () => live && setSession(null)
    );
    return () => {
      live = false;
    };
  }, [api, item.medium, item.id]);

  let body: ReactNode;
  if (media.status === 'ready') {
    body =
      item.medium === 'video' ? (
        <video
          src={media.media.url}
          controls
          autoPlay
          style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto' }}
          data-testid="library-viewer-video"
        />
      ) : (
        <img
          src={media.media.url}
          alt={item.prompt}
          style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto', objectFit: 'contain' }}
          data-testid="library-viewer-image"
        />
      );
  } else if (media.status === 'error') {
    body = (
      <CenteredState
        title="Could not open this file"
        body={media.message}
        action={
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={media.retry}
            data-testid="library-viewer-retry-btn"
          >
            Try again
          </Button>
        }
        testId="library-viewer-error"
      />
    );
  } else if (item.availability !== 'ready') {
    body = (
      <CenteredState
        title={item.availability === 'pending_scan' ? 'Still being checked' : 'No longer available'}
        body={
          item.availability === 'pending_scan'
            ? 'The file is being scanned. It will open here once that finishes.'
            : 'This file was removed or blocked.'
        }
        testId="library-viewer-unavailable"
      />
    );
  } else {
    body = (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress size="sm" />
      </Stack>
    );
  }

  return (
    <Modal open onClose={onClose}>
      <ModalDialog
        layout="center"
        sx={{ width: 'min(960px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto' }}
        data-testid="library-viewer"
      >
        <ModalClose data-testid="library-viewer-close-btn" />
        <Box sx={{ pt: 3 }}>{body}</Box>
        <Stack spacing={0.5} sx={{ pt: 1 }}>
          <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {item.prompt}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ flex: 1, minWidth: 0 }}>
              {[item.model, formatDate(item.createdAt)].filter(Boolean).join(' · ')}
            </Typography>
            {session && (
              <Button
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => onOpenSession(session)}
                data-testid="library-viewer-open-session-btn"
              >
                Open in Studio
              </Button>
            )}
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

/**
 * The Library place's main pane: the account's finished image and video generations, newest
 * first, in a grid. Opening one shows it full size, with a jump to the desktop session a Studio
 * Create saved it into when there is one.
 */
export function LibraryMain({
  filter,
  accountKey,
  api,
  onOpenSession,
  onOpenStudio,
}: {
  filter: LibraryFilter;
  /** Changes when the signed-in account does, which drops every loaded page. */
  accountKey: string;
  api: LibraryApi;
  onOpenSession: (sessionId: string) => void;
  onOpenStudio: () => void;
}) {
  const feed = useLibraryFeed(filter, accountKey, api);
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scroller.current?.scrollTo?.({ top: 0 });
  }, [filter]);

  let content: ReactNode;
  if (feed.items.length === 0 && feed.error) {
    content = (
      <CenteredState
        title="Could not load your Library"
        body={feed.error}
        action={
          <Button size="sm" variant="outlined" color="neutral" onClick={feed.retry} data-testid="library-retry-btn">
            Try again
          </Button>
        }
        testId="library-error"
      />
    );
  } else if (feed.items.length === 0 && (feed.initial || feed.loading)) {
    content = (
      <Stack alignItems="center" sx={{ mt: 12 }} data-testid="library-loading">
        <CircularProgress size="sm" />
      </Stack>
    );
  } else if (feed.items.length === 0 && !feed.hasMore) {
    content = (
      <CenteredState
        title={filter === 'all' ? 'Nothing made yet' : `No ${filterLabel(filter).toLowerCase()} yet`}
        body="Images and videos you generate in Studio, on desktop or the web, collect here."
        action={
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={onOpenStudio}
            data-testid="library-open-studio-btn"
          >
            Open Studio
          </Button>
        }
        testId="library-empty"
      />
    );
  } else {
    content = (
      <Stack spacing={2}>
        <Box
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5 }}
          data-testid="library-grid"
        >
          {feed.items.map(item => (
            <LibraryTile key={`${item.medium}:${item.id}`} item={item} api={api} onOpen={setOpen} />
          ))}
        </Box>
        {feed.error && (
          <Typography level="body-sm" color="danger" textAlign="center" data-testid="library-page-error">
            {feed.error}
          </Typography>
        )}
        {feed.hasMore && (
          <Box sx={{ textAlign: 'center' }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={feed.loading}
              onClick={feed.error ? feed.retry : feed.loadMore}
              data-testid="library-load-more-btn"
            >
              {feed.error ? 'Try again' : 'Load more'}
            </Button>
          </Box>
        )}
      </Stack>
    );
  }

  return (
    <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0, bgcolor: 'background.surface' }} data-testid="library-place">
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 2, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}
        data-testid="library-header"
      >
        <Typography level="title-sm" sx={{ flex: 1 }}>
          {filterLabel(filter)}
        </Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Refresh"
          disabled={feed.loading}
          onClick={feed.refresh}
          data-testid="library-refresh-btn"
        >
          <ReloadIcon />
        </IconButton>
      </Stack>
      <Box ref={scroller} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, py: 2.5, ...thinScrollbarSx }}>
        {content}
      </Box>
      {open && (
        <LibraryViewer
          item={open}
          api={api}
          onClose={() => setOpen(null)}
          onOpenSession={sessionId => {
            setOpen(null);
            onOpenSession(sessionId);
          }}
        />
      )}
    </Stack>
  );
}
