import { setupSpecUser } from './helpers/spec-setup';

// Trust-approved because the spec invites a member, which the new-account trust gate blocks for a
// minutes-old account.
setupSpecUser({ key: 'projects', authFile: 'projects-user.json', apiKeyTrustApproved: true });
