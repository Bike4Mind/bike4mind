import { Config } from '@bike4mind/server-utils/utils/config';

const TWILIO_TIMEOUT_MS = 8000;
const UNSET_SECRET = 'not-configured';

/** Twilio error codes: 60200 invalid parameter (a malformed number), 60203 max send attempts reached. */
const INVALID_NUMBER_CODES = new Set([60200, 21211, 21614]);
const RATE_LIMIT_CODES = new Set([60203, 20429]);

export class TwilioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null
  ) {
    super(`Twilio API responded ${status}${code === null ? '' : ` (code ${code})`}`);
    this.name = 'TwilioApiError';
  }

  get rateLimited(): boolean {
    return this.status === 429 || (this.code !== null && RATE_LIMIT_CODES.has(this.code));
  }

  get invalidNumber(): boolean {
    return this.code !== null && INVALID_NUMBER_CODES.has(this.code);
  }
}

type TwilioCredentials = { accountSid: string; authToken: string; verifyServiceSid: string };

const isSet = (value: string | undefined): value is string => Boolean(value) && value !== UNSET_SECRET;

export function twilioCredentials(): TwilioCredentials | null {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = Config;
  if (!isSet(TWILIO_ACCOUNT_SID) || !isSet(TWILIO_AUTH_TOKEN) || !isSet(TWILIO_VERIFY_SERVICE_SID)) return null;
  return { accountSid: TWILIO_ACCOUNT_SID, authToken: TWILIO_AUTH_TOKEN, verifyServiceSid: TWILIO_VERIFY_SERVICE_SID };
}

async function twilioRequest(
  credentials: TwilioCredentials,
  url: string,
  form?: Record<string, string>
): Promise<Record<string, unknown>> {
  const auth = Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64');
  const response = await fetch(url, {
    method: form ? 'POST' : 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new TwilioApiError(response.status, typeof record.code === 'number' ? record.code : null);
  }
  return record;
}

export type PhoneLookup = { valid: boolean; countryCode: string | null; lineType: string | null };

/** Lookup v2 with line type intelligence; `lineType` is Twilio's value, e.g. mobile, landline, nonFixedVoip. */
export async function lookupPhone(credentials: TwilioCredentials, phone: string): Promise<PhoneLookup> {
  const url = `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(phone)}?Fields=line_type_intelligence`;
  const body = await twilioRequest(credentials, url);
  const intelligence = body.line_type_intelligence as { type?: unknown } | null | undefined;
  return {
    valid: body.valid === true,
    countryCode: typeof body.country_code === 'string' ? body.country_code : null,
    lineType: typeof intelligence?.type === 'string' ? intelligence.type : null,
  };
}

export async function sendVerificationCode(credentials: TwilioCredentials, phone: string): Promise<void> {
  await twilioRequest(
    credentials,
    `https://verify.twilio.com/v2/Services/${credentials.verifyServiceSid}/Verifications`,
    {
      To: phone,
      Channel: 'sms',
    }
  );
}

/** True only for an approved code. Twilio answers 404 once a verification has expired or used its attempts. */
export async function checkVerificationCode(
  credentials: TwilioCredentials,
  phone: string,
  code: string
): Promise<boolean> {
  try {
    const body = await twilioRequest(
      credentials,
      `https://verify.twilio.com/v2/Services/${credentials.verifyServiceSid}/VerificationCheck`,
      { To: phone, Code: code }
    );
    return body.status === 'approved';
  } catch (error) {
    if (error instanceof TwilioApiError && error.status === 404) return false;
    throw error;
  }
}
