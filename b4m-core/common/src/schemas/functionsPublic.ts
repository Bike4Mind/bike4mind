import { z } from 'zod';
import { REQUEST_TIMEOUT_ERROR_CODE } from '../apiErrorCodes';
import { CALLABLE_FUNCTION_TRUST_LABELS } from '../types/entities/CallableFunctionTypes';
import {
  CALLABLE_FUNCTION_CALL_OUTCOMES,
  CALLABLE_FUNCTION_CALL_SURFACES,
} from '../types/entities/CallableFunctionCallTypes';
import { ApiErrorSchema } from './chat';
import { paginatedResponseSchema } from './pagination';

/**
 * Wire schemas for the public functions contracts (api-contract/contracts/functions.contract.ts). snake_case and
 * closed. Dates are ISO-8601 strings.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep this file free
 * of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

export const FunctionIdParamSchema = z.object({
  id: z.string().describe('The function id, as `id` in the list.'),
});

const FunctionSchemaObject = z
  .record(z.string(), z.unknown())
  .describe(
    'A JSON Schema object: `type: "object"`, `properties`, `required` and `additionalProperties: false`. ' +
      'Each number field carries `unit`, an extension keyword naming its unit (`1` when dimensionless).'
  );

export const PublicFunctionSchema = z.object({
  id: z.string(),
  slug: z.string().describe("The function's name, fixed when it was saved."),
  description: z.string(),
  trust_label: z
    .enum(CALLABLE_FUNCTION_TRUST_LABELS)
    .nullable()
    .describe(
      '`verified` when a cited worked example passed on the server at promotion; otherwise `unverified`. ' +
        '`platform` is a `verified` function curated and checked by Bike4Mind.'
    ),
  pin_version: z.number().int().describe('The artifact version the function runs.'),
  pin_seq: z.number().int().nullable().describe('The promotion that made this pin live: 1 for the first.'),
  updated_at: z.string(),
});

export const PublicFunctionDetailSchema = PublicFunctionSchema.extend({
  input_schema: FunctionSchemaObject,
  output_schema: FunctionSchemaObject,
});

export const ListFunctionsResponseSchema = paginatedResponseSchema(PublicFunctionSchema);

export const GetFunctionResponseSchema = z.object({ data: PublicFunctionDetailSchema });

export const InvokeFunctionRequestSchema = z
  .object({
    input: z.record(z.string(), z.unknown()).describe("The function's inputs, as its `input_schema` describes them."),
    mode: z
      .enum(['sync', 'async'])
      .optional()
      .describe(
        '`sync` (default) answers with the result and stops at 45 s. `async` answers 202 with a `call_id` once ' +
          "every check has passed, runs to the organization's time limit, and keeps the result for 24 hours at " +
          '`GET /api/v1/functions/calls/{call_id}`.'
      ),
  })
  .strict();

export const FunctionStampSchema = z
  .object({
    function_id: z.string(),
    slug: z.string(),
    pin_version: z.number().int(),
    pin_seq: z.number().int().nullable(),
    code_hash: z.string().describe('sha256 hex of the pinned code.'),
    input_hash: z.string().describe('sha256 hex of the canonical JSON of the validated inputs.'),
    runtime: z.object({ kind: z.string(), version: z.string(), lock_hash: z.string().nullable() }),
    packages: z.array(z.object({ name: z.string(), version: z.string() })),
    data: z
      .array(
        z.object({
          name: z.string(),
          mode: z.string(),
          sha256: z.string(),
          bytes: z.number().int(),
          fetched_at: z.string().optional(),
        })
      )
      .describe('Each data file the call read, by hash. Empty while functions read no data files.'),
    uses: z.array(z.unknown()).describe('Other functions the call used. Always empty today.'),
    trust_label: z.enum(CALLABLE_FUNCTION_TRUST_LABELS).nullable(),
    surface: z.enum(CALLABLE_FUNCTION_CALL_SURFACES),
    duration_ms: z.number(),
    called_at: z.string(),
  })
  .describe('What the call ran on: the code, inputs, runtime, and packages, by hash and version.');

export const InvokeFunctionResponseSchema = z.object({
  output: z.record(z.string(), z.unknown()).describe('The outputs, checked against `output_schema`.'),
  stamp: FunctionStampSchema,
});

const FunctionProblemSchema = z.object({
  path: z.string().describe('The field, as a dotted path from the inputs, such as `span`.'),
  message: z.string(),
});

export const InvokeFunctionInputErrorSchema = ApiErrorSchema.extend({
  problems: z.array(FunctionProblemSchema).optional().describe('Each input that does not fit `input_schema`.'),
});

export const InvokeFunctionFailedErrorSchema = ApiErrorSchema.extend({
  outcome: z.enum(CALLABLE_FUNCTION_CALL_OUTCOMES).describe('How the call ended.'),
  stamp: FunctionStampSchema.optional(),
});

export const InvokeFunctionTimeoutErrorSchema = ApiErrorSchema.extend({
  errorCode: z.literal(REQUEST_TIMEOUT_ERROR_CODE),
  stamp: FunctionStampSchema.optional(),
});

export const InvokeFunctionQueuedResponseSchema = z.object({
  call_id: z.string().describe('Poll `GET /api/v1/functions/calls/{call_id}` for the result.'),
  status: z.literal('queued'),
});

export const FunctionCallIdParamSchema = z.object({
  call_id: z.string().describe('The `call_id` an asynchronous invoke answered with.'),
});

export const GetFunctionCallResponseSchema = z.object({
  call_id: z.string(),
  status: z
    .enum(['queued', 'running', 'finished'])
    .describe('`queued` and `running` carry nothing else; poll again. `finished` carries how the call ended.'),
  outcome: z
    .enum(CALLABLE_FUNCTION_CALL_OUTCOMES)
    .optional()
    .describe('How a finished call ended: `ok` carries `output`; any other outcome carries `error`.'),
  output: z.record(z.string(), z.unknown()).optional().describe('The outputs, checked against `output_schema`.'),
  stamp: FunctionStampSchema.optional(),
  error: z.string().optional(),
  problems: z.array(FunctionProblemSchema).optional(),
});

export type PublicFunction = z.infer<typeof PublicFunctionSchema>;
export type PublicFunctionDetail = z.infer<typeof PublicFunctionDetailSchema>;
export type FunctionStampWire = z.infer<typeof FunctionStampSchema>;
