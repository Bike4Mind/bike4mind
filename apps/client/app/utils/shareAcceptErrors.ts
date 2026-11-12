import { isAxiosError } from 'axios';

export type ShareAcceptFailureKind = 'revoked' | 'expired' | 'domain' | 'full' | 'member';

export interface ShareAcceptFailure {
  kind: ShareAcceptFailureKind;
  title: string;
  body: string;
}

// Keyed on the messages sharingService.acceptInvite throws (b4m-core/services/src/sharingService/accept.ts);
// any other failure keeps the hook's toast and the page's go-home behaviour.
export function describeAcceptFailure(error: unknown): ShareAcceptFailure | null {
  if (!isAxiosError(error)) return null;
  const data: unknown = error.response?.data;
  const message =
    data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
      ? (data as { message: string }).message
      : '';
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
  if (message === 'You are already a member of this organization') {
    return { kind: 'member', title: "You're already a member", body: 'You already belong to this organization.' };
  }
  return null;
}
