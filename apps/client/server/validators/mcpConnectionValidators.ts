import {
  BadRequestError,
  MCP_API_KEY_SCHEMES,
  MCP_CONNECTION_LIMITS,
  MCP_CONNECTION_TRANSPORTS,
  MCP_TOOL_APPROVAL_MODES,
  MCP_TOOL_STATES,
  McpConnectionSlugSchema,
  mcpApiKeyHeaderNameProblem,
  mcpApiKeyValueProblem,
} from '@bike4mind/common';
import { z } from 'zod';

// Bodies of the custom MCP connection routes (pages/api/mcp-connections/**). `.strict()` everywhere:
// owner, status, preset and URL-derived fields are server-set, so a body naming one is refused
// rather than silently ignored.

const headerNameSchema = z.string().superRefine((name, ctx) => {
  const problem = mcpApiKeyHeaderNameProblem(name);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const apiKeyValueSchema = z.string().superRefine((value, ctx) => {
  const problem = mcpApiKeyValueProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

const apiKeyAuthSchema = z
  .object({
    kind: z.literal('api_key'),
    headerName: headerNameSchema.default('Authorization'),
    scheme: z.enum(MCP_API_KEY_SCHEMES).default('Bearer'),
    value: apiKeyValueSchema,
  })
  .strict();

const noAuthSchema = z.object({ kind: z.literal('none') }).strict();

const displayNameSchema = z.string().trim().min(1).max(MCP_CONNECTION_LIMITS.displayNameLength);

export const mcpConnectionCreateBodySchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    displayName: displayNameSchema,
    slug: McpConnectionSlugSchema.optional(),
    transport: z.enum(MCP_CONNECTION_TRANSPORTS).default('auto'),
    auth: z.discriminatedUnion('kind', [noAuthSchema, apiKeyAuthSchema]),
  })
  .strict();

export type McpConnectionCreateBody = z.infer<typeof mcpConnectionCreateBodySchema>;

export const mcpConnectionPatchBodySchema = z
  .object({
    displayName: displayNameSchema.optional(),
    enabled: z.boolean().optional(),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(MCP_CONNECTION_LIMITS.toolNameLength),
            /** The tool's `versionHash` as the reviewer saw it; a stale one is a 409. */
            versionHash: z.string().min(1).max(128),
            enabled: z.boolean().optional(),
            approval: z.enum(MCP_TOOL_APPROVAL_MODES).optional(),
            state: z.enum(MCP_TOOL_STATES).optional(),
          })
          .strict()
      )
      .max(MCP_CONNECTION_LIMITS.maxTools)
      .optional(),
  })
  .strict()
  .refine(body => body.displayName !== undefined || body.enabled !== undefined || body.tools !== undefined, {
    message: 'Nothing to update',
  });

export type McpConnectionPatchBody = z.infer<typeof mcpConnectionPatchBodySchema>;

/** Rotation keeps the stored header name and scheme unless the body replaces them. */
export const mcpConnectionApiKeyBodySchema = z
  .object({
    headerName: headerNameSchema.optional(),
    scheme: z.enum(MCP_API_KEY_SCHEMES).optional(),
    value: apiKeyValueSchema,
  })
  .strict();

export type McpConnectionApiKeyBody = z.infer<typeof mcpConnectionApiKeyBodySchema>;

/**
 * Parses a body or throws a 400 listing each issue's path and message. Issue messages never carry
 * the submitted value, so an API key in a rejected body is not echoed back.
 */
export function parseMcpConnectionBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestError('Invalid request body', {
      code: 'invalid_body',
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data;
}
