import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Tombstone for the Sora-era alias. Sora shut down upstream, so this route answers 410 with the shared error
 * envelope instead of disappearing (CONVENTIONS.md section 7: no silent removal). Not a contract route: 410 is
 * outside the contract status set.
 */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(410).json({
    error: 'This endpoint was removed. Use POST /api/v1/video-generations.',
    replacement: 'POST /api/v1/video-generations',
  });
}
