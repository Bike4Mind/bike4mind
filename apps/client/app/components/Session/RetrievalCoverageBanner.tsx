import { Box, Typography } from '@mui/joy';
import { COVERAGE_BANNER_TITLE, COVERAGE_BANNER_BODY, COVERAGE_BANNER_DETAILS_LABEL } from '@bike4mind/common';

/**
 * Notice shown under a reply whose knowledge-base grounding covered only part of the library.
 *
 * The server has computed this on every partially-covered turn since forced retrieval shipped, but
 * it reached only `PromptMetaInspector` - a draggable debug panel - so the reader the coverage note
 * exists to protect never saw it. The whole point is the confident false negative: an answer drawn
 * from a partial scan reads exactly like "the library has nothing on this".
 *
 * A component rather than inline JSX for the reason ArtifactElisionBanner gives: `PromptReplies` is
 * ~1900 lines and a harness for it would be out of proportion to pinning a testid and the copy.
 *
 * One quiet line with the reasons behind a disclosure that starts closed. An earlier version showed
 * a full-width block above the answer with the reasons open, on the argument that a warning a reader
 * has to open something to explain is not actionable. It was reversed: ordinary readers took the
 * block for an error, and the reasons carry nothing they can act on until they ask for them. The
 * reasons are reader-facing text without document ids; the diagnostic string stays in
 * `promptMeta.warnings`. AnswerDiagnosisPanel keeps the on-demand view of the same signal.
 *
 * Unlike the truncation banners, this one carries no `completed` gate, because it cannot reach a
 * streaming reply in the first place: StatusManager rebuilds promptMeta down to just
 * `citables`/`artifacts` for the streaming frame, so `retrievalCoverage` only arrives with the
 * finished quest. That is transport, not intent - if `retrievalCoverage` is ever added to the
 * streaming payload, gate this on completion at the call site or it will flash mid-stream.
 */
export function RetrievalCoverageBanner({ reasons = [] }: { reasons?: string[] }) {
  return (
    <Box data-testid="retrieval-coverage-warning" sx={{ my: 1 }}>
      {/* Native disclosure: closed by default, keyboard and screen-reader operable without state. */}
      {reasons.length > 0 ? (
        <Box component="details" sx={{ '& > summary': { cursor: 'pointer', listStyle: 'none' } }}>
          <Box
            component="summary"
            sx={{ '&::-webkit-details-marker': { display: 'none' }, '&:hover': { textDecoration: 'underline' } }}
          >
            <Typography level="body-sm" textColor="warning.plainColor" component="span">
              {COVERAGE_BANNER_TITLE}{' '}
              <Typography component="span" level="body-sm" sx={{ textDecoration: 'underline' }}>
                {COVERAGE_BANNER_DETAILS_LABEL}
              </Typography>
            </Typography>
          </Box>
          <Box data-testid="retrieval-coverage-reasons" sx={{ mt: 0.5 }}>
            <Typography level="body-sm" textColor="text.secondary">
              {COVERAGE_BANNER_BODY}
            </Typography>
            <Box
              component="ul"
              sx={{ m: 0, mt: 0.5, pl: '1.25rem', display: 'flex', flexDirection: 'column', gap: 0.25 }}
            >
              {reasons.map(reason => (
                <li key={reason}>
                  <Typography level="body-sm" textColor="text.secondary">
                    {reason}
                  </Typography>
                </li>
              ))}
            </Box>
          </Box>
        </Box>
      ) : (
        <Typography level="body-sm" textColor="warning.plainColor">
          {COVERAGE_BANNER_TITLE}
        </Typography>
      )}
    </Box>
  );
}
