import { z } from 'zod';
import { ApiErrorSchema } from './chat';

/**
 * Wire schemas for the test-persona endpoints (`/api/v1/personas`) and the login-code redemption
 * route (`/api/personas/redeem`). Served by apps/client/pages/api/v1/personas/*.
 */

/** The name a caller picks; it becomes the username middle and, on production, the mailbox. */
export const PERSONA_NAME_PATTERN = /^[a-z0-9]{1,24}$/;

/** `errorCode` on the 404 a stage answers while PersonaMintEnabled is off. */
export const PERSONA_ENDPOINT_OFF_CODE = 'persona_endpoint_off';

/** Path a browser opens with `?code=` to land signed in as the persona; POST it `{ code }` for tokens. */
export const PERSONA_REDEEM_PATH = '/api/personas/redeem';

export const MintPersonaRequestSchema = z.strictObject({
  name: z.string().regex(PERSONA_NAME_PATTERN).describe('1 to 24 lowercase letters or digits.'),
});

export const PersonaIdParamSchema = z.object({
  id: z.string().min(1),
});

export const MintPersonaResponseSchema = z.object({
  persona: z.object({
    id: z.string(),
    username: z.string(),
    email: z.string(),
    expires_at: z.string().describe('When the persona is disabled, as an ISO 8601 timestamp.'),
  }),
  created: z.boolean().describe('False when a live persona with this name, minted by the caller, was returned.'),
  login_code: z.string().describe('Single-use code that signs in as the persona. Redeem it promptly.'),
  login_code_expires_at: z.string().describe('When `login_code` stops working, as an ISO 8601 timestamp.'),
  login_path: z
    .string()
    .describe('Path, relative to the app origin, that signs a browser in as the persona. It carries `login_code`.'),
});

export const PersonaErrorSchema = ApiErrorSchema.extend({
  errorCode: z.literal(PERSONA_ENDPOINT_OFF_CODE).optional(),
});

export type MintPersonaRequest = z.infer<typeof MintPersonaRequestSchema>;
export type MintPersonaResponse = z.infer<typeof MintPersonaResponseSchema>;
