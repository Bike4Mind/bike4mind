// Legacy alias for the nextRouteForContract handler at POST /api/v1/sessions/{id}/clone.
export { default } from '../../v1/sessions/[id]/clone';

export const config = {
  api: {
    externalResolver: true,
  },
};
