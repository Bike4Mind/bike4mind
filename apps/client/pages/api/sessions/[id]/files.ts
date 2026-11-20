// Legacy alias for the nextRouteForContract handler at GET /api/v1/sessions/{id}/files, used by the SPA.
import { sessionFilesHandler } from '../../v1/sessions/[id]/files';

export default sessionFilesHandler({ browser: true });

export const config = {
  api: {
    externalResolver: true,
  },
};
