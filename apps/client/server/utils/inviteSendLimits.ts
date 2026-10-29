import { cacheRepository, User } from '@bike4mind/database';
import { TooManyRequestsError } from '@bike4mind/utils';
import { sendInviteNotificationEmails } from '@server/utils/mailer/inviteNotificationEmail';

// Creating an invite emails every recipient, including addresses with no account, with the
// inviter's name, the document name and their message. These bounds keep the invite routes
// (pages/api/projects/[id]/invites.ts and pages/api/[type]/[id]/invites) from being a free mail
// relay. The request limit is loose because the Add Members modal sends one request per selected
// user; typed addresses, the only way to reach someone with no account, get their own tighter
// hourly budget, counted per address and the same whether or not the address has an account.
export const MAX_INVITE_RECIPIENTS = 25;
export const MAX_INVITE_MESSAGE_LENGTH = 1000;
export const INVITE_REQUESTS_PER_HOUR = 100;
export const TYPED_ADDRESS_INVITES_PER_HOUR = 20;
export const HOUR_MS = 60 * 60 * 1000;

const MAX_EMAILED_NAME_LENGTH = 60;

const capLength = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 3)}...` : value);

/**
 * Charges each typed address (a recipient containing '@') against the user's hourly budget and
 * throws once it is spent. One counter shared by every invite route, so a caller cannot double
 * the budget by switching routes. Call it before the invite is created.
 */
export async function chargeTypedAddressBudget(userId: string, recipients: string[] | undefined): Promise<void> {
  const typedAddresses = (recipients ?? []).filter(recipient => recipient.includes('@'));
  for (let i = 0; i < typedAddresses.length; i++) {
    const { success } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `rate-limit:${userId}:invite-typed-address`,
      TYPED_ADDRESS_INVITES_PER_HOUR,
      HOUR_MS
    );
    if (!success) throw new TooManyRequestsError('Too many email invitations. Try again later.');
  }
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
