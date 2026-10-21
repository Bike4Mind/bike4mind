/** Digits in an emailed sign-in code; mirrors OTC_CODE_LENGTH in b4m-core/services sendOTC.ts. */
export const OTC_CODE_LENGTH = 8;

// Codes issued before the move to 8 digits stay valid until their token expires; the server only
// accepts one if it matches a live token, so letting it through here costs nothing.
const LEGACY_OTC_CODE_LENGTH = 6;

/** Keeps only digits, up to OTC_CODE_LENGTH, from typed or pasted input. */
export const sanitizeOtcInput = (value: string): string => value.replace(/\D/g, '').slice(0, OTC_CODE_LENGTH);

/** Whether a sanitized code is complete enough to submit. */
export const isSubmittableOtcCode = (code: string): boolean =>
  code.length === OTC_CODE_LENGTH || code.length === LEGACY_OTC_CODE_LENGTH;

export const OTC_CODE_PLACEHOLDER = '0'.repeat(OTC_CODE_LENGTH);
