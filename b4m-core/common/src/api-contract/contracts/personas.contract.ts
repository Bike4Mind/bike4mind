import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ScopeForbiddenErrorSchema } from '../../schemas/chat';
import {
  MintPersonaRequestSchema,
  MintPersonaResponseSchema,
  PersonaErrorSchema,
  PersonaIdParamSchema,
} from '../../schemas/personas';

const WHO =
  'Only admins and developers can call it: an API key needs the `personas:mint` scope, which is ' +
  'offered only to them, and the key owner is re-checked on every call. ';

const FORBIDDEN =
  'The key lacks `personas:mint`, or its owner is no longer an admin or developer, or the caller is a persona.';

const OFF = 'Persona minting is turned off on this deployment (`errorCode: persona_endpoint_off`).';

/**
 * Test personas for QA bots: throwaway non-admin accounts with no credits that expire on their own.
 * Served by apps/client/pages/api/v1/personas/index.ts and [id].ts. The login code is redeemed at
 * PERSONA_REDEEM_PATH, which is not part of the public contract because it issues sessions.
 */
export const mintPersonaContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/personas',
  operationId: 'mintPersona',
  summary: 'Mint a test persona',
  description:
    'Creates a throwaway test account for automated QA and returns a single-use login code for it. ' +
    WHO +
    'The account is a non-admin user with no credits that is disabled when `expires_at` passes. ' +
    'Minting a name you already hold a live persona under returns that persona with a new login code ' +
    '(`200`, `created: false`) instead of creating another. Redeem the code at `login_path`: open it ' +
    'in a browser to land signed in, or `POST` `{ "code": "<login_code>" }` to `/api/personas/redeem` ' +
    'for an access token and refresh token. A code works once and expires at `login_code_expires_at`.',
  tags: ['Account'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.PERSONAS_MINT],
  request: MintPersonaRequestSchema,
  requestExample: { name: 'alpha' },
  responses: {
    200: { description: 'Your live persona with this name, with a new login code.', schema: MintPersonaResponseSchema },
    201: { description: 'The persona was created.', schema: MintPersonaResponseSchema },
    403: { description: FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: OFF, schema: PersonaErrorSchema },
    409: { description: 'Another user holds a live persona with this name.', schema: PersonaErrorSchema },
    422: { description: 'The body is not exactly `{ name }` with a valid name.', schema: PersonaErrorSchema },
    429: {
      description: 'The deployment-wide persona caps (per 24 hours, or live) are reached, or the rate limit is.',
      schema: PersonaErrorSchema,
    },
    503: { description: 'Persona minting is not configured on this deployment.', schema: PersonaErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: { name: 'alpha' } },
});

export const deletePersonaContract = defineEndpoint({
  method: 'delete',
  path: '/api/v1/personas/{id}',
  operationId: 'deletePersona',
  summary: 'Delete a test persona',
  description:
    'Deletes a test persona and signs it out everywhere. ' +
    WHO +
    'You can delete personas you minted; an admin can delete any persona. Anything else, including ' +
    'an ordinary account, answers `404`.',
  tags: ['Account'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.PERSONAS_MINT],
  pathParams: PersonaIdParamSchema,
  responses: {
    204: { description: 'The persona was deleted.', noBody: true },
    403: { description: FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: `No persona you can delete has this id. Also: ${OFF}`, schema: PersonaErrorSchema },
    429: { description: 'Rate limit exceeded.', schema: PersonaErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false },
});
