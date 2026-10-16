import { Alert, Typography } from '@mui/joy';
import type { z } from 'zod';
import type { RetrievalFloorRejectionSchema } from '@bike4mind/common';

/**
 * Notice above a reply whose library grounding came back empty because an operator-configured
 * relevance floor sits above the one measured for the library's embedding model. Without it the
 * reader sees only an answer that cites nothing, on every turn, and cannot tell why.
 */
export function RetrievalFloorBanner({
  floorPct,
  measuredPct,
  embeddingModel,
}: z.infer<typeof RetrievalFloorRejectionSchema>) {
  return (
    <Alert
      data-testid="retrieval-floor-warning"
      color="warning"
      variant="soft"
      sx={{ my: 1, p: '16px', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}
    >
      <Typography level="title-sm" textColor="inherit">
        No passages were relevant enough
      </Typography>
      <Typography level="body-sm" textColor="text.secondary">
        Nothing in your library scored {floorPct}% or higher, the minimum an administrator set. That is above the{' '}
        {measuredPct}% measured for {embeddingModel}, so this reply did not use your library. If this keeps happening,
        ask an administrator to clear the minimum similarity setting.
      </Typography>
    </Alert>
  );
}
