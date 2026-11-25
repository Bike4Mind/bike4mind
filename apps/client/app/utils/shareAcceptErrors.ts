import { isAxiosError } from 'axios';
import { InviteType } from '@bike4mind/common';

export type ShareAcceptScreenKind =
  'revoked' | 'expired' | 'domain' | 'full' | 'member' | 'used' | 'already-member' | 'removed' | 'unavailable';

export interface ShareAcceptScreen {
  kind: ShareAcceptScreenKind;
  title: string;
  body: string;
}

// Keyed on the messages sharingService.acceptInvite throws (b4m-core/services/src/sharingService/accept.ts);
// any other failure keeps the hook's toast and the page's go-home behaviour.
export function describeAcceptFailure(error: unknown): ShareAcceptScreen | null {
  if (!isAxiosError(error)) return null;
  const data: unknown = error.response?.data;
  const envelope = data && typeof data === 'object' ? (data as { error?: unknown; message?: unknown }) : {};
  const message =
    typeof envelope.error === 'string' ? envelope.error : typeof envelope.message === 'string' ? envelope.message : '';
  if (message === 'Invite has been revoked') {
    return { kind: 'revoked', title: 'This invite was revoked', body: 'Ask the person who shared it for a new link.' };
  }
  if (message === 'Invite has expired') {
    return { kind: 'expired', title: 'This invite has expired', body: 'Ask the person who shared it for a new link.' };
  }
  if (message.startsWith('This invite is limited to')) {
    return { kind: 'domain', title: "This invite isn't open to your account", body: `${message}.` };
  }
  if (message === 'Organization is full') {
    return {
      kind: 'full',
      title: 'This organization is full',
      body: 'There are no seats left. Ask an organization admin to add seats.',
    };
  }
  if (message === 'This space is full') {
    return {
      kind: 'full',
      title: 'This space is full',
      body: 'There is no room left. Ask a space admin to make room.',
    };
  }
  if (message === 'You cannot join this space') {
    return {
      kind: 'removed',
      title: "You can't join this space",
      body: 'A space admin removed you from it. Ask an admin to invite you by name.',
    };
  }
  if (
    message === 'Space not found' ||
    message === 'The inviter can no longer grant access to this space' ||
    message === 'Feature not available'
  ) {
    return {
      kind: 'unavailable',
      title: 'This space is not available',
      body: 'It may have been deleted, or the person who shared this link can no longer invite people to it.',
    };
  }
  if (message === 'You are already a member of this space') {
    return { kind: 'member', title: "You're already a member", body: 'You already belong to this space.' };
  }
  if (message === 'You are already a member of this organization') {
    return { kind: 'member', title: "You're already a member", body: 'You already belong to this organization.' };
  }
  if (message === 'Invite has no remaining users') {
    return {
      kind: 'used',
      title: 'This invite has been used up',
      body: 'Ask the person who shared it for a new link.',
    };
  }
  return null;
}

// A named org invite accepted by someone already in the org succeeds without changing their role.
export function acceptOutcomeScreen(result: unknown, inviteType?: InviteType): ShareAcceptScreen | null {
  if (!result || typeof result !== 'object') return null;
  if ((result as { acceptOutcome?: unknown }).acceptOutcome !== 'already-member') return null;
  if (inviteType === InviteType.Space) {
    return { kind: 'already-member', title: "You're already a member", body: 'You already belong to this space.' };
  }
  return {
    kind: 'already-member',
    title: "You're already a member",
    body: 'You already belong to this organization, so your role stays the same. An organization owner can change your role.',
  };
}
