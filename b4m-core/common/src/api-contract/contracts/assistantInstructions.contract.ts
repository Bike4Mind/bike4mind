import { z } from 'zod';
import { INSTRUCTION_LIMIT_REACHED_ERROR_CODE } from '../../apiErrorCodes';
import { defineEndpoint } from '../defineEndpoint';
import {
  AssistantInstructionIdParamSchema,
  AssistantInstructionListResponseSchema,
  AssistantInstructionSchema,
  CreateAssistantInstructionRequestSchema,
} from '../../schemas/assistantInstruction';
import { ApiErrorSchema } from '../../schemas/chat';

const createInstructionErrorSchema = ApiErrorSchema.extend({
  errorCode: z.literal(INSTRUCTION_LIMIT_REACHED_ERROR_CODE).optional(),
});

const JWT_ONLY_NOTE =
  'Authenticate with a JWT access token of the signed-in user. Instructions are visible only to the user ' +
  'who saved them: a list returns only your own, and deleting one that is not yours answers `404`, ' +
  'exactly like a missing instruction. ';

/**
 * Standing instructions the brief composer reads as preferences. Served by
 * apps/client/pages/api/v1/assistant/instructions/index.ts (list, create) and [id].ts (delete).
 */
export const listAssistantInstructionsContract = /* @__PURE__ */ defineEndpoint({
  method: 'get',
  path: '/api/v1/assistant/instructions',
  operationId: 'listAssistantInstructions',
  summary: 'List assistant instructions',
  description:
    'Lists your standing instructions, oldest first. The assistant reads them when it composes a brief, as ' +
    'preferences for what to highlight and how to word it. ' +
    JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  responses: {
    200: { description: 'Your instructions.', schema: AssistantInstructionListResponseSchema },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});

export const createAssistantInstructionContract = /* @__PURE__ */ defineEndpoint({
  method: 'post',
  path: '/api/v1/assistant/instructions',
  operationId: 'createAssistantInstruction',
  summary: 'Add an assistant instruction',
  description:
    'Saves a standing instruction (up to 280 characters, trimmed) that later briefs follow. Instructions shape ' +
    'what a brief highlights and how it is worded; they cannot add a decision or change the brief format. ' +
    'You can keep up to 20. ' +
    JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  request: CreateAssistantInstructionRequestSchema,
  requestExample: { text: 'Always lead with anything about invoices.' },
  responses: {
    201: { description: 'The saved instruction.', schema: AssistantInstructionSchema },
    400: {
      description:
        'You already keep as many instructions as allowed (`errorCode: instruction_limit_reached`), or the ' +
        'body is not valid JSON or the account is unavailable. Nothing is saved.',
      schema: createInstructionErrorSchema,
    },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    422: { description: 'The text is empty, whitespace only, or longer than 280 characters.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false, body: { text: '<instruction>' } },
});

export const deleteAssistantInstructionContract = /* @__PURE__ */ defineEndpoint({
  method: 'delete',
  path: '/api/v1/assistant/instructions/{id}',
  operationId: 'deleteAssistantInstruction',
  summary: 'Remove an assistant instruction',
  description: 'Removes one of your instructions. Briefs composed after this no longer follow it. ' + JWT_ONLY_NOTE,
  tags: ['AI'],
  auth: 'jwtOnly',
  pathParams: AssistantInstructionIdParamSchema,
  responses: {
    204: { description: 'The instruction is removed.', noBody: true },
    401: { description: 'Missing or invalid JWT.', schema: ApiErrorSchema },
    404: { description: 'No such instruction, or it is not yours.', schema: ApiErrorSchema },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: '<access_token>', streaming: false },
});
