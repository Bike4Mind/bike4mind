import { z } from 'zod';
import {
  CALLABLE_FUNCTION_DATA_LIMITS,
  CALLABLE_FUNCTION_EXAMPLE_LIMITS,
  CALLABLE_FUNCTION_GRANT_LIMITS,
  CALLABLE_FUNCTION_LIMITS,
  CALLABLE_FUNCTION_SOURCE_MODES,
  CALLABLE_FUNCTION_SOURCE_URL_MAX_CHARS,
  CALLABLE_FUNCTION_STATES,
  CALLABLE_FUNCTION_TRUST_LABELS,
  CallableFunctionGrantVisibilitySchema,
} from '../types/entities/CallableFunctionTypes';
import { CALLABLE_FUNCTION_CALL_SURFACES } from '../types/entities/CallableFunctionCallTypes';
import { MCP_TOOL_APPROVAL_MODES } from '../types/entities/McpConnectionTypes';
import { FUNCTION_CONTRACT_LIMITS } from './functionContract';
import { ApiErrorSchema } from './chat';
import { paginatedResponseSchema } from './pagination';
import { FunctionStampSchema } from './functionsPublic';

/**
 * Wire schemas for the public authoring contracts (api-contract/contracts/functionsAuthoring.contract.ts): the key
 * owner's own functions, in every state, with their code. snake_case; dates are ISO-8601 strings. Bodies are shape
 * only: the services in packages/server-utils/src/callableFunctions make every real check, for this API and the app.
 *
 * Imported directly (never through the schemas barrel), so keep this file free of `@bike4mind/*` imports.
 */

export const FunctionDataNameParamSchema = z.object({
  id: z.string().describe('The function id.'),
  name: z.string().describe('The data file name, as `name` in `data`.'),
});

const codeField = z
  .string()
  .min(1)
  .max(CALLABLE_FUNCTION_LIMITS.maxSourceBytes)
  .describe(
    `The Python source: a \`FUNCTION\` contract and a \`run\` function, at most ${CALLABLE_FUNCTION_LIMITS.maxSourceBytes / 1024} KB.`
  );

const contractField = z
  .record(z.string(), z.unknown())
  .describe(
    'The `FUNCTION` object in `code`, as JSON. The server checks it, and checks it against the code before a test ' +
      'run or a promotion.'
  );

export const CreateFunctionRequestSchema = z.object({ code: codeField, contract: contractField }).strict();

export const SaveFunctionCodeRequestSchema = z
  .object({
    code: codeField,
    contract: contractField,
    pin_version: z
      .number()
      .int()
      .min(1)
      .describe('The `pin_version` you read. A function changed since is refused with `code: "version_changed"`.'),
  })
  .strict();

export const UpdateFunctionRequestSchema = z
  .union([
    z.object({ enabled: z.boolean().describe('`false` turns the function off; it stays saved.') }).strict(),
    z
      .object({
        approval: z
          .enum(MCP_TOOL_APPROVAL_MODES)
          .describe('When chat asks before calling the function: `default`, `always_allow`, or `always_ask`.'),
      })
      .strict(),
  ])
  .describe('One setting per request.');

const valueRecord = z.record(z.string(), z.unknown());

const ExampleSchema = z
  .object({
    name: z.string().min(1).max(FUNCTION_CONTRACT_LIMITS.maxDescriptionLength),
    input: valueRecord,
    expected: valueRecord,
    tolerance: z
      .object({ abs: z.number().min(0).optional(), rel: z.number().min(0).optional() })
      .strict()
      .optional(),
    citation: z
      .string()
      .min(1)
      .max(CALLABLE_FUNCTION_EXAMPLE_LIMITS.maxCitationLength)
      .describe('Where a reader can check `expected`.'),
  })
  .strict();

export const SetFunctionExamplesRequestSchema = z
  .object({
    examples: z
      .array(ExampleSchema)
      .max(CALLABLE_FUNCTION_EXAMPLE_LIMITS.maxExamples)
      .describe('Every worked example, replacing the ones saved.'),
  })
  .strict();

export const RunFunctionTestsRequestSchema = z
  .object({
    tests: z
      .array(z.string().min(1).max(FUNCTION_CONTRACT_LIMITS.maxDescriptionLength))
      .min(1)
      .max(FUNCTION_CONTRACT_LIMITS.maxTests)
      .optional()
      .describe('Names of declared tests to run; every declared test when absent.'),
  })
  .strict();

export const PinFunctionDataRequestSchema = z
  .object({
    file_id: z.string().min(1).max(200).describe('A file you uploaded.'),
    name: z.string().min(1).max(64).describe('The name the function reads it under, at `/data/<name>`.'),
  })
  .strict();

const SourceSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().min(1).max(CALLABLE_FUNCTION_SOURCE_URL_MAX_CHARS).describe('An https URL on an allowed origin.'),
  mode: z
    .enum(CALLABLE_FUNCTION_SOURCE_MODES)
    .describe('`live` is fetched on each call; `pinned` is fetched once at promotion.'),
});

export const SetFunctionSourcesRequestSchema = z
  .object({
    sources: z
      .array(SourceSchema.strict())
      .max(CALLABLE_FUNCTION_DATA_LIMITS.maxSources)
      .describe('Every source, replacing the ones saved. Leave one out to remove it.'),
  })
  .strict();

export const PromoteFunctionRequestSchema = z.object({}).strict();

const GrantsFields = {
  visibility: CallableFunctionGrantVisibilitySchema.describe(
    '`private` shares with the people in `user_ids` only; `project` and `organization` also share with everyone ' +
      'in the one named.'
  ),
  project_id: z.string().min(1).max(64).optional(),
  organization_id: z.string().min(1).max(64).optional(),
  user_ids: z.array(z.string().min(1).max(64)).max(CALLABLE_FUNCTION_GRANT_LIMITS.maxUserIds),
};

export const ShareFunctionRequestSchema = z
  .object(GrantsFields)
  .strict()
  .describe('The whole share, replacing the one saved. Find a person id with the recipient lookup.');

export const FunctionRecipientQuerySchema = z.object({
  email: z.string().min(1).max(320).describe('The exact address of the person to share with.'),
});

const ShareSchema = z.object(GrantsFields);

export const AuthoredFunctionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  description: z.string(),
  state: z.enum(CALLABLE_FUNCTION_STATES).describe('`live` once promoted; any edit returns it to `draft`.'),
  status: z
    .enum([...CALLABLE_FUNCTION_STATES, 'disabled', 'source_deleted'])
    .describe('`state`, or `disabled` when turned off, or `source_deleted` when its artifact is gone.'),
  enabled: z.boolean(),
  approval: z.enum(MCP_TOOL_APPROVAL_MODES),
  trust_label: z.enum(CALLABLE_FUNCTION_TRUST_LABELS).nullable().describe('Null unless live.'),
  pin_version: z.number().int().describe('The artifact version the function is pinned to.'),
  pin_seq: z.number().int().nullable().describe('The promotion of this pin; null until promoted.'),
  code_hash: z.string().describe('sha256 hex of the pinned code.'),
  pinned_at: z.string(),
  artifact_id: z.string(),
  latest_version: z.number().int().nullable(),
  update_available: z.boolean().describe('The artifact has a version newer than the pin.'),
  data: z.array(z.object({ name: z.string(), sha256: z.string(), bytes: z.number().int(), pinned_at: z.string() })),
  sources: z.array(
    SourceSchema.extend({
      pinned: z
        .object({ sha256: z.string(), bytes: z.number().int(), fetched_at: z.string() })
        .optional()
        .describe('What promotion froze for a `pinned` source.'),
    })
  ),
  examples: z.array(ExampleSchema),
  share: ShareSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const CaseResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  outcome: z.string().describe('How the case ended: `ok`, `error`, `timeout`, `not_run`, and so on.'),
  reason: z.string().optional(),
  duration_ms: z.number().optional(),
  call_id: z.string().optional().describe('The call-log row the case wrote.'),
});

const ServerRunSchema = z.object({
  at: z.string(),
  passed: z.number().int(),
  failed: z.number().int(),
  results: z.array(CaseResultSchema.extend({ kind: z.enum(['test', 'example']) })),
  stamp: FunctionStampSchema.optional(),
});

export const AuthoredFunctionDetailSchema = AuthoredFunctionSchema.extend({
  code: z.string().describe('The pinned Python source.'),
  contract: z.record(z.string(), z.unknown()).describe('The `FUNCTION` contract as stored.'),
  last_server_run: ServerRunSchema.nullable().describe('The run the last promotion made.'),
});

export const AuthoredFunctionResponseSchema = z.object({ data: AuthoredFunctionSchema });

export const AuthoredFunctionDetailResponseSchema = z.object({ data: AuthoredFunctionDetailSchema });

export const ListAuthoredFunctionsResponseSchema = paginatedResponseSchema(AuthoredFunctionSchema);

export const FunctionTestRunResponseSchema = z.object({
  data: z.object({
    function_id: z.string(),
    passed: z.number().int(),
    failed: z.number().int(),
    not_run: z.number().int().describe('Cases the 45 s budget did not reach; run them by name.'),
    results: z.array(
      CaseResultSchema.extend({
        error_class: z.string().optional(),
        problems: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
        mismatch: z
          .object({ path: z.string(), expected: z.unknown(), actual: z.unknown() })
          .nullable()
          .describe('The first output that differs from `expected`.'),
        stamp: FunctionStampSchema.optional(),
      })
    ),
  }),
});

export const FunctionPromotionResponseSchema = z.object({
  data: z.object({ function: AuthoredFunctionSchema, run: ServerRunSchema }),
});

export const FunctionShareResponseSchema = z.object({
  data: z.object({
    share: ShareSchema.nullable(),
    people: z.array(z.object({ id: z.string(), name: z.string() })).describe('Display names of `user_ids`.'),
  }),
});

export const FunctionRecipientResponseSchema = z.object({
  data: z
    .object({ id: z.string(), name: z.string() })
    .nullable()
    .describe('The account holding that address; null when none does.'),
});

export const FunctionCallSummaryResponseSchema = z.object({
  data: z.object({
    since: z.string(),
    total: z.number().int(),
    outcomes: z.record(z.string(), z.number().int()),
    recent: z.array(
      z.object({
        id: z.string(),
        started_at: z.string(),
        outcome: z.string(),
        surface: z.enum(CALLABLE_FUNCTION_CALL_SURFACES),
        by_recipient: z.boolean().describe('Made by someone the function is shared with; who is not shown.'),
        pin_seq: z.number().int().optional(),
        duration_ms: z.number(),
        api_key: z.object({ name: z.string().nullable() }).optional(),
      })
    ),
  }),
});

export const FunctionAuthoringErrorSchema = ApiErrorSchema.extend({
  code: z.string().optional().describe('Why the request was refused, such as `version_changed` or `not_live`.'),
  problems: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional()
    .describe('Each field of the contract or the examples that has a problem.'),
});

export type AuthoredFunction = z.infer<typeof AuthoredFunctionSchema>;
export type AuthoredFunctionDetail = z.infer<typeof AuthoredFunctionDetailSchema>;
