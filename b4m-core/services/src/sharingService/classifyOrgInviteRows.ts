import { z } from 'zod';

export type OrgInviteRowStatus =
  'invite' | 'already_member' | 'already_pending' | 'invalid' | 'duplicate' | 'seat_limit';

export interface OrgInviteRow {
  /** Trimmed, lowercased address; equal to the trimmed input when the row is invalid. */
  email: string;
  raw: string;
  status: OrgInviteRowStatus;
}

export interface OrgInviteRowContext {
  /** Lowercased emails of current members, the owner included or not. */
  memberEmails: ReadonlySet<string>;
  ownerEmail?: string | null;
  /** Lowercased addresses already holding an active organization invite. */
  pendingEmails: ReadonlySet<string>;
  /** Seats left for new invites: seats - (users + 1 for the owner) - pending. */
  availableSeats: number;
}

/**
 * Sorts pasted addresses into what a bulk organization invite would do with each, without
 * touching the database, so one bad row does not fail the batch the way createInvite's
 * all-or-nothing checks do. Seats go to valid new addresses in input order.
 */
export const classifyOrgInviteRows = (rows: readonly string[], context: OrgInviteRowContext): OrgInviteRow[] => {
  const owner = context.ownerEmail?.trim().toLowerCase();
  const seen = new Set<string>();
  let seatsLeft = Math.max(0, context.availableSeats);

  return rows.map(raw => {
    const trimmed = raw.trim();
    const email = trimmed.toLowerCase();
    if (!z.email().safeParse(email).success) return { email: trimmed, raw, status: 'invalid' };
    if (seen.has(email)) return { email, raw, status: 'duplicate' };
    seen.add(email);
    if (email === owner || context.memberEmails.has(email)) return { email, raw, status: 'already_member' };
    if (context.pendingEmails.has(email)) return { email, raw, status: 'already_pending' };
    if (seatsLeft === 0) return { email, raw, status: 'seat_limit' };
    seatsLeft -= 1;
    return { email, raw, status: 'invite' };
  });
};
