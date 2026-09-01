import { Alert, Typography } from '@mui/joy';
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
 * cap. `reasons` renders behind a disclosure because it is diagnostic prose written for an operator
 * ("the 4000-chunk per-turn scan budget was reached"), and only some of it is actionable.
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
      sx={{ my: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}
    >
      <Typography level="title-sm">⚠️ {COVERAGE_BANNER_TITLE}</Typography>
      {/* textColor inherit: body-sm defaults to text.tertiary at 50% alpha, which drops below
          contrast minimums inside a soft Alert. */}
      <Typography level="body-sm" textColor="inherit">
        {COVERAGE_BANNER_BODY}
      </Typography>
      {!!reasons?.length && (
        <details data-testid="retrieval-coverage-reasons">
          <summary>
            <Typography level="body-xs" textColor="inherit" component="span">
              {COVERAGE_BANNER_DETAILS_LABEL}
            </Typography>
          </summary>
          <ul style={{ margin: '4px 0 0', paddingInlineStart: '1.25rem' }}>
            {reasons.map(reason => (
              <li key={reason}>
                <Typography level="body-xs" textColor="inherit">
                  {reason}
                </Typography>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Alert>
  );
}
