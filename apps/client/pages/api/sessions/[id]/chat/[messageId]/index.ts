// Legacy alias for the nextRouteForContract handler at /api/v1/sessions/{id}/messages/{messageId}
// (GET, PUT, DELETE).
export { default } from '../../../../v1/sessions/[id]/messages/[messageId]';

export const config = {
  api: {
    externalResolver: true,
  },
};
