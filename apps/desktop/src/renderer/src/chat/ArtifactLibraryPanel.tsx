import { useCallback, useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatArtifactSummary, ChatArtifactView } from '@shared/chat';
import { ArtifactCard, TYPE_LABEL } from './ArtifactCard';
import { ChevronIcon, CloseIcon } from './icons';
import { contentColumnSx } from './layout';

/** What one row knows about its body: not asked for yet, in flight, here, or refused. */
type RowBody =
  { state: 'loading' } | { state: 'ready'; artifact: ChatArtifactView } | { state: 'error'; error: string };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load this artifact.';
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/**
 * One artifact in the library: a summary row that fetches and renders its body when opened.
 *
 * Lazy on purpose. The list route returns artifact documents without their bodies - those live
 * in their own collection - so a panel that rendered everything up front would pull every HTML
 * file this account owns across the wire to draw a list of titles.
 */
function ArtifactRow({ summary }: { summary: ChatArtifactSummary }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<RowBody | null>(null);

  // Fetched from the click rather than from an effect on `open`: an effect would have to name
  // `body` among its dependencies to fetch only once, and writing 'loading' to `body` then
  // re-runs it, whose cleanup cancels the read it just started. Opening IS the event here.
  const toggle = () => {
    const opening = !open;
    setOpen(opening);
    if (!opening || body?.state === 'loading' || body?.state === 'ready') return;
    setBody({ state: 'loading' });
    void window.b4m.chat.readArtifact(summary.id).then(
      result =>
        setBody(
          result.artifact
            ? { state: 'ready', artifact: result.artifact }
            : { state: 'error', error: result.error ?? 'Could not load this artifact.' }
        ),
      (error: unknown) => setBody({ state: 'error', error: describe(error) })
    );
  };

  const date = formatDate(summary.createdAt);

  return (
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', mb: 1, overflow: 'hidden' }} data-testid="artifact-library-row">
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        onClick={toggle}
        sx={{ px: 1.5, py: 1.25, cursor: 'pointer', '&:hover': { bgcolor: 'background.level1' } }}
        data-testid="artifact-library-row-summary"
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" fontWeight="lg" noWrap>
            {summary.title}
          </Typography>
          {date && (
            <Typography level="body-xs" textColor="text.tertiary">
              {date}
            </Typography>
          )}
        </Box>
        <Chip size="sm" variant="soft" color="neutral" data-testid="artifact-library-row-type">
          {TYPE_LABEL[summary.type] ?? summary.type}
        </Chip>
        <Box sx={{ display: 'flex', opacity: 0.6 }}>
          <ChevronIcon open={open} />
        </Box>
      </Stack>

      {open && (
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          {body?.state === 'loading' && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
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
}

/**
 * Every artifact this account has made from a desktop client.
 *
 * The SERVER's list, not a walk of the local sessions: an artifact is posted as it is made, so
 * the server holds the union across machines and the current body after any web-app edit. That
 * is also why this can fail in ways a local list could not, and why being signed out is a
 * message here rather than an empty panel.
 */
export function ArtifactLibraryPanel({ onClose }: { onClose: () => void }) {
  const [summaries, setSummaries] = useState<ChatArtifactSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await window.b4m.chat.listArtifacts();
    setSummaries(result.artifacts);
    setError(result.error ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const empty = !loading && !error && summaries?.length === 0;

  return (
    <Stack sx={{ flex: 1, minWidth: 0 }} data-testid="artifact-library">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <Typography level="title-sm" sx={{ flex: 1 }}>
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
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto' }}>
        <Box sx={{ ...contentColumnSx, py: 2 }}>
          {/* An error and a stale list can be on screen together: a refresh that fails leaves
              the rows it already had, which are still worth reading. */}
          {error && (
            <Alert size="sm" color="warning" variant="soft" sx={{ mb: 1.5 }} data-testid="artifact-library-error">
              {error}
            </Alert>
          )}

          {loading && !summaries && (
            <Typography level="body-sm" textColor="text.tertiary" data-testid="artifact-library-loading">
              Loading artifacts...
            </Typography>
          )}

          {empty && (
            <Typography level="body-sm" textColor="text.tertiary" data-testid="artifact-library-empty">
              No artifacts yet. Ask for a page, a diagram or a file and it will appear here.
            </Typography>
          )}

          {summaries?.map(summary => (
            <ArtifactRow key={summary.id} summary={summary} />
          ))}
        </Box>
      </Box>
    </Stack>
  );
}
