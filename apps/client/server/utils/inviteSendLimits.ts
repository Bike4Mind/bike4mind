import { cacheRepository, User } from '@bike4mind/database';
import { TooManyRequestsError } from '@bike4mind/utils';
import { sendInviteNotificationEmails } from '@server/utils/mailer/inviteNotificationEmail';
import { MAX_INVITE_MESSAGE_LENGTH, MAX_INVITE_RECIPIENTS } from '@client/types/api';

export { MAX_INVITE_MESSAGE_LENGTH, MAX_INVITE_RECIPIENTS };

// Creating an invite emails every recipient, including addresses with no account, with the
// inviter's name, the document name and their message. These bounds keep the invite routes
// (pages/api/projects/[id]/invites.ts and pages/api/[type]/[id]/invites) from being a free mail
// relay. The budgets count recipients, not requests, so a share link (which mails nobody) costs
// nothing and a bulk share costs what it sends. Typed addresses, the only way to reach someone
// with no account, get their own tighter budget, counted the same whether or not the address has
// an account.
const INVITE_RECIPIENTS_PER_HOUR = 200;
const TYPED_ADDRESS_INVITES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

// Shared by both routes and every type, so the budget cannot be multiplied by switching either.
const recipientBudgetKey = (userId: string) => `rate-limit:${userId}:invite-recipients`;
// Legacy project-only key name, kept so counters survive the move to this shared helper.
const typedAddressBudgetKey = (userId: string) => `rate-limit:${userId}:project-invite-typed-address`;

const MAX_EMAILED_NAME_LENGTH = 60;

const capLength = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 3)}...` : value);

export type InviteBudgetReservation = {
  /** Gives the budget back, for an invite that was never created. Idempotent. */
  release: () => Promise<void>;
};

const NOTHING_RESERVED: InviteBudgetReservation = { release: async () => {} };

/** All-or-nothing add of `amount` to a fixed hourly window; null when it does not fit. */
async function reserve(key: string, amount: number, limit: number): Promise<InviteBudgetReservation | null> {
  if (amount === 0) return NOTHING_RESERVED;
  const { success, expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(key, amount, limit, HOUR_MS);
  if (!success) return null;
  let released = false;
  return {
    release: async () => {
      // A lapsed window has already been reset; decrementing would eat into the next one.
      if (released || expiresAt.getTime() <= Date.now()) return;
      released = true;
      await Promise.all(Array.from({ length: amount }, () => cacheRepository.decrementCounter(key)));
    },
  };
}

/**
 * Charges an invite's recipients against the user's hourly budgets, and throws when they do not
 * fit. Call it after the request is validated and before the invite is created, and release the
 * reservation if creation fails. `chargeTypedAddresses` is for project invites only: they are the
 * one type the sharing service lets name an address with no account (sharingService/create.ts);
 * every other type refuses or drops such an address, so charging it there would only fail bulk
 * shares to existing users.
 */
export async function reserveInviteSendBudget(
  userId: string,
  recipients: string[] | undefined,
  { chargeTypedAddresses }: { chargeTypedAddresses: boolean }
): Promise<InviteBudgetReservation> {
  const recipientList = recipients ?? [];
  const recipientReservation = await reserve(
    recipientBudgetKey(userId),
    recipientList.length,
    INVITE_RECIPIENTS_PER_HOUR
  );
  if (!recipientReservation) throw new TooManyRequestsError('Too many invitations. Try again later.');
  if (!chargeTypedAddresses) return recipientReservation;

  const typedAddressCount = recipientList.filter(recipient => recipient.includes('@')).length;
  const typedReservation = await reserve(
    typedAddressBudgetKey(userId),
    typedAddressCount,
    TYPED_ADDRESS_INVITES_PER_HOUR
  );
  if (!typedReservation) {
    await recipientReservation.release();
    throw new TooManyRequestsError('Too many email invitations. Try again later.');
  }
  return {
    release: async () => {
      await Promise.all([recipientReservation.release(), typedReservation.release()]);
    },
  };
}

/**
 * Emails the invitees. An address with no account gets only the fixed template: no custom message,
 * and the inviter-chosen names capped, so the platform cannot be used to mail free text to
 * strangers. Recipients who already have an account get the message as before. Which is which is
 * never reflected in the response, so the lookup discloses nothing to the inviter.
 */
export async function notifyInvitees(params: {
  recipients: string[];
  sharerName: string;
  sharerEmail: string;
  documentName: string;
  typeName: string;
  inviteLink: string;
  message?: string;
}): Promise<void> {
  const { recipients, sharerName, sharerEmail, documentName, typeName, inviteLink, message } = params;
  const accounts = await User.find({ email: { $in: recipients } }, { email: 1 })
    .collation({ locale: 'en', strength: 2 })
    .lean();
  const hasAccount = new Set(accounts.map(account => account.email?.toLowerCase()));
  const members = recipients.filter(recipient => hasAccount.has(recipient.toLowerCase()));
  const strangers = recipients.filter(recipient => !hasAccount.has(recipient.toLowerCase()));

  await Promise.all([
    members.length > 0 &&
      sendInviteNotificationEmails(members, sharerName, sharerEmail, documentName, typeName, inviteLink, message),
    strangers.length > 0 &&
      sendInviteNotificationEmails(
        strangers,
        capLength(sharerName, MAX_EMAILED_NAME_LENGTH),
        sharerEmail,
        capLength(documentName, MAX_EMAILED_NAME_LENGTH),
        typeName,
        inviteLink
      ),
  ]);
}
