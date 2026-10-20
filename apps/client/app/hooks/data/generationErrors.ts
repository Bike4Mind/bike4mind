/**
 * The error handling shared by every generation-job surface (video and music rate-limit the same way). Each kind
 * keeps its own `MESSAGES` map and calls describeGenerationError with it.
 */
import { isAxiosError } from 'axios';
import type { PayerAccount } from './generationBillingTarget';

export const GENERATION_RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.';
export const GENERATION_ACCOUNT_CANNOT_PAY_MESSAGE =
  'Your selected account cannot pay for this. Switch accounts and try again.';

/** Passed only by create requests, which bill an account; a cancel is not a billing error. */
export type GenerationBilling = { noun: string; billingAccount: PayerAccount | null };

function describeInsufficientCredits({ noun, billingAccount }: GenerationBilling): string {
  if (!billingAccount) return `You do not have enough credits for this ${noun}.`;
  if (billingAccount.personal) return `Your personal credits are not enough for this ${noun}.`;
  return `${billingAccount.name} does not have enough credits for this ${noun}.`;
}

/** The `errorCode` on a response body, when it has one; the single reader every generation surface uses. */
export const readErrorCode = (data: unknown): unknown =>
  typeof data === 'object' && data !== null && 'errorCode' in data ? data.errorCode : undefined;

/**
 * The user-facing message for a failed generation request: the shared rate-limit text, else the message for the
 * kind's own errorCode, else `fallback`. With `billing`, insufficient_credits names the paying account.
 *
 * A 403 while an organization account is selected says to switch accounts. That is a heuristic on the selection,
 * not on `errorCode`: the session-path refusal (`resolveActiveOrg`) carries no code, so it is indistinguishable
 * from any other 403 (blocked IP, CSRF) shown during the same request. A personal selection sends no org, so a
 * 403 there falls through to the kind's own messages.
 * The response's `error` text is never shown - messages come from the code.
 */
export function describeGenerationError<TCode extends string>(
  codes: readonly TCode[],
  messages: Record<TCode, string>,
  error: unknown,
  fallback: string,
  billing?: GenerationBilling
): string {
  if (!isAxiosError(error)) return fallback;
  if (error.response?.status === 429) return GENERATION_RATE_LIMITED_MESSAGE;
  const billsOrganization = !!billing?.billingAccount && !billing.billingAccount.personal;
  if (billsOrganization && error.response?.status === 403) return GENERATION_ACCOUNT_CANNOT_PAY_MESSAGE;
  const code = readErrorCode(error.response?.data);
  if (billing && code === 'insufficient_credits') return describeInsufficientCredits(billing);
  if (typeof code === 'string' && (codes as readonly string[]).includes(code)) return messages[code as TCode];
  return fallback;
}
