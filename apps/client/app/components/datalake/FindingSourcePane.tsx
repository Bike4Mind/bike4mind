import { Alert, Box, Link, Skeleton, Typography } from '@mui/joy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import type { LakeFindingSource } from '@bike4mind/common';
import { useGetFabFile, useGetFabFileContent } from '@client/app/hooks/data/fabFiles';
import MarkdownViewer, { UnmarkedCitedPassage } from '@client/app/components/Knowledge/MarkdownViewer';

/**
 * One side of a finding's side-by-side review (#3044): the document a passage came from, rendered
 * with that passage marked in place.
 *
 * Reuses `MarkdownViewer`'s `citedPassage` marking (#3038) rather than rendering the excerpt on its
 * own, because the excerpt alone is the thing a curator cannot judge - "we are the only vendor
 * doing X" means something different in a product page than in a 2019 press release, and only the
 * surrounding document says which it is. The viewer also owns the drifted-passage fallback, so a
 * document that has been edited since detection still shows the curator what was quoted.
 *
 * Fetches its own document rather than taking content as a prop: a finding carries file IDS, the
 * panes are independent, and a slow S3 read on one source must not hold up the other.
 */
export default function FindingSourcePane({ source }: { source: LakeFindingSource }) {
  const { data: file, isLoading: fileLoading, isError: fileError } = useGetFabFile(source.fabFileId);
  const {
    data: content,
    isLoading: contentLoading,
    isError: contentError,
  } = useGetFabFileContent(file ?? null, { strict: true });

  // The finding's own `fileName` first: it is what the detector saw, so it names the document even
  // when the file read fails or the document has since been renamed out from under the quote.
  const title = source.fileName ?? file?.fileName ?? 'Untitled document';
  const loading = fileLoading || contentLoading;

  return (
    <Box
      data-testid={`finding-source-pane-${source.fabFileId}`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'sm',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ px: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.level1' }}>
        <Typography level="title-sm" noWrap data-testid="finding-source-title">
          {title}
        </Typography>
        {/* The citation, and a working one: the `?article=` deep link is the shareable form the
            router keeps alive for exactly this. New tab, because losing the comparison to follow
            one side of it defeats the surface. */}
        <Link
          href={`/data-lakes?article=${encodeURIComponent(source.fabFileId)}`}
          target="_blank"
          rel="noopener noreferrer"
          level="body-xs"
          endDecorator={<OpenInNewIcon sx={{ fontSize: 12 }} />}
          data-testid="finding-source-citation"
        >
          Open document
        </Link>
      </Box>

      {/* Its own scroller: each pane scrolls to its own marked passage, and a shared one would let
          the second viewer's scroll-into-view drag the first pane's passage back off screen. */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1 }}>
        {loading ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1.5 }}>
            <Skeleton variant="text" level="body-md" sx={{ width: '100%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '90%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '70%' }} />
          </Box>
        ) : content ? (
          <MarkdownViewer content={content} citedPassage={source.excerpt} />
        ) : (
          // The document could not be read - deleted since detection, or unreadable to this curator.
          // The quoted passage is still shown: it is the evidence the finding rests on, and a pane
          // that went blank here would leave one half of a comparison with nothing in it at all.
          <Box sx={{ p: 1.5 }} data-testid="finding-source-unavailable">
            <Alert color="warning" size="sm" sx={{ mb: 1.5 }}>
              <Typography level="body-xs">
                {/* A failed read and an empty document are told apart deliberately. "No readable
                    text" is a claim about the CORPUS that a curator may act on, so a transient
                    fetch failure must never be reported as one. */}
                {fileError
                  ? 'This document could not be opened. It may have been deleted since it was detected.'
                  : contentError
                    ? 'This document could not be loaded. Try again shortly.'
                    : 'This document has no readable text.'}
              </Typography>
            </Alert>
            <UnmarkedCitedPassage passage={source.excerpt} title="Quoted passage" />
          </Box>
        )}
      </Box>
    </Box>
  );
}
