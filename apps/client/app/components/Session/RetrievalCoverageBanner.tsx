import { Alert, Box, Typography } from '@mui/joy';
import { COVERAGE_BANNER_TITLE, COVERAGE_BANNER_BODY, COVERAGE_BANNER_DETAILS_LABEL } from '@bike4mind/common';

/**
 * Notice shown above a reply whose knowledge-base grounding covered only part of the library.
 *
 * The server has computed this on every partially-covered turn since forced retrieval shipped, but
 * it reached only `PromptMetaInspector` - a draggable debug panel - so the reader the coverage note
 * exists to protect never saw it. The whole point is the confident false negative: an answer drawn
 * from a partial scan reads exactly like "the library has nothing on this".
 *
 * A component rather than inline JSX for the reason ArtifactElisionBanner gives: `PromptReplies` is
 * ~1900 lines and a harness for it would be out of proportion to pinning a testid and the copy.
 *
 * Stated as a fact, not hedged - unlike elision, this is not a heuristic. The server knows it hit a
 * cap. `reasons` is shown outright rather than behind a disclosure: it is the evidence for the claim
 * above it, and a reader who has to open something to find out WHY a scan was partial has already
 * been given a warning they cannot act on.
 *
 * Unlike the truncation banners beside it, this one carries no `completed` gate, because it cannot
 * reach a streaming reply in the first place: StatusManager rebuilds promptMeta down to just
 * `citables`/`artifacts` for the streaming frame, so `retrievalCoverage` only arrives with the
 * finished quest. That is transport, not intent - if `retrievalCoverage` is ever added to the
 * streaming payload, gate this on completion at the call site or it will flash mid-stream.
 */
export function RetrievalCoverageBanner({ reasons }: { reasons?: string[] }) {
  return (
    <Alert
      data-testid="retrieval-coverage-warning"
      color="warning"
      variant="soft"
      sx={{ my: 1, p: '16px', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}
    >
      {/* Inherits the Alert's warning ink, so the title carries the colour and the body can
          sit back in the app's own recessive text token. */}
      <Typography level="title-sm" textColor="inherit">
        {COVERAGE_BANNER_TITLE}
      </Typography>
      <Typography level="body-sm" textColor="text.secondary">
        {COVERAGE_BANNER_BODY}
      </Typography>
      {/* Still conditional: an empty list would leave a heading standing over nothing. */}
      {!!reasons?.length && (
        <Box data-testid="retrieval-coverage-reasons" sx={{ mt: 0.5 }}>
          <Typography level="title-sm" textColor="inherit">
            {COVERAGE_BANNER_DETAILS_LABEL}
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
      )}
    </Alert>
  );
}
