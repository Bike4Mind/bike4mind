// Legacy alias for the nextRouteForContract handler at GET /api/v1/sessions/{id}/files.
export { default } from '../../v1/sessions/[id]/files';

export const config = {
  api: {
    externalResolver: true,
  },
};
