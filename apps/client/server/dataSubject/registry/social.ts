import type { DataHolderRegistry } from '../types';

export const socialHolders = {
  // Admin-authored comparison prompts, not the voters.
  ArenaPair: {
    kind: 'holder',
    references: [{ path: 'createdBy', matchBy: 'userId', action: 'anonymize' }],
  },
  ArenaVote: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
  Connection: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
    secretPaths: ['sid'],
  },
  Feedback: {
    kind: 'holder',
    references: [
      { path: 'userId', matchBy: 'userId', action: 'deleteDocument' },
      // Older rows may carry only the email.
      { path: 'userEmail', matchBy: 'email', action: 'deleteDocument' },
    ],
    // A display name on the person's own submission; erased with the document.
    unrelatedPaths: ['username'],
  },
  // Free text of a report; shares its _id with the owning Feedback and expires after 90 days.
  FeedbackText: { kind: 'viaParent', parent: 'Feedback', foreignKey: '_id' },
  Friendship: {
    kind: 'holder',
    references: [
      { path: 'requester', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'recipient', matchBy: 'userId', action: 'deleteDocument' },
    ],
  },
  Group: {
    kind: 'noUserData',
    note: 'An organization-owned group (name, type); membership lives elsewhere.',
  },
  // userId is the sender (may be 'SYSTEM'); receiverId is the person the message is for.
  Inbox: {
    kind: 'holder',
    references: [
      { path: 'receiverId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'userId', matchBy: 'userId', action: 'anonymize' },
    ],
  },
  Invite: {
    kind: 'holder',
    references: [
      { path: 'inviterId', matchBy: 'userId', action: 'deleteDocument' },
      { path: 'recipients.pending', matchBy: 'email', action: 'pullFromArray' },
      { path: 'recipients.accepted', matchBy: 'email', action: 'pullFromArray' },
      { path: 'recipients.refused', matchBy: 'email', action: 'pullFromArray' },
      { path: 'typedRecipients', matchBy: 'email', action: 'pullFromArray' },
    ],
    secretPaths: ['token'],
    // The inviter's display label; erased with the invite they sent.
    unrelatedPaths: ['username'],
  },
  Modal: {
    kind: 'noUserData',
    note: 'Platform announcement content and view/agree counters; no per-person data.',
  },
  OrgFeedbackSummaryJob: {
    kind: 'holder',
    references: [{ path: 'requestedBy', matchBy: 'userId', action: 'anonymize' }],
  },
  OverwatchAmplifyPost: {
    kind: 'noUserData',
    note: 'A public social post of an external product account, not a Bike4Mind user.',
  },
  // Holds encrypted OAuth tokens (accessToken, refreshToken) of the product account; never exported.
  OverwatchSocialConnection: {
    kind: 'noUserData',
    note: 'A connection of an external product to a social platform, not a Bike4Mind user.',
  },
  QuerySubscription: {
    kind: 'noUserData',
    note: 'Ephemeral realtime query subscriptions keyed by websocket connection id; no user identifier.',
  },
} satisfies DataHolderRegistry;
