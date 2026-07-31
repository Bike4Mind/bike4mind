import { Alert, Typography } from '@mui/joy';
import { ELISION_BANNER_TITLE, ELISION_BANNER_BODY } from '@bike4mind/common';

/**
 * Advisory notice shown above an artifact whose body looks abbreviated - placeholder comments, or
 * handlers calling functions that were never defined.
 *
 * A component rather than inline JSX so the surface has a render test. QA's report on this feature was
 * literally "the banner never appeared", and `PromptReplies` is a ~1900-line component with 57 imports,
 * so a harness for it would be out of proportion to what needs pinning. The DECISION to show this
 * lives in `shouldWarnElidedArtifact` (separately unit-tested); this file is only the markup, and the
 * test alongside it pins the testid and the copy contract.
 *
 * Deliberately softer in tone than the truncation banner it sits beside: truncation is a certainty
 * read from the provider's stop reason, this is a heuristic, and the artifact below renders exactly as
 * generated either way.
 */
export function ArtifactElisionBanner() {
  return (
    <Alert
      data-testid="artifact-elided-warning"
      color="warning"
      variant="soft"
      sx={{ my: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}
    >
      <Typography level="title-sm">⚠️ {ELISION_BANNER_TITLE}</Typography>
      <Typography level="body-sm">
        {ELISION_BANNER_BODY} Check it before sharing - or ask me to write it out in full.
      </Typography>
    </Alert>
  );
}
