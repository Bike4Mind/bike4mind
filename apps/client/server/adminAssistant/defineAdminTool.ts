import { z } from 'zod';
import type { AdminAssistantToolName } from '@bike4mind/common';
import type { ToolContext, ToolDefinition } from '@bike4mind/services/llm/tools';

export type AdminToolResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: 'forbidden' | 'invalid_input' | 'not_found' | 'ambiguous' | 'failed';
      message: string;
      candidates?: unknown[];
    };

type AdminToolContext = Omit<ToolContext, 'config'>;
type ToolParametersSchema = ReturnType<ToolDefinition['implementation']>['toolSchema']['parameters'];

type AdminToolInput = z.ZodObject<z.ZodRawShape>;

type AdminToolSpec<S extends AdminToolInput> = {
  name: AdminAssistantToolName;
  description: string;
  input: S;
  run: (args: z.infer<S>, context: AdminToolContext) => Promise<AdminToolResult>;
};

const forbidden: AdminToolResult = { ok: false, error: 'forbidden', message: 'Admin access is required.' };

function toParametersSchema(input: AdminToolInput): ToolParametersSchema {
  const { $schema: _draftUri, ...schema } = z.toJSONSchema(input) as Record<string, unknown>;
  // The LLM tool schema format has no slot for the draft URI; every admin input is a z.object,
  // so the remaining shape is the `{ type: 'object', properties }` the format expects.
  return schema as ToolParametersSchema;
}

/**
 * The single wrapper every admin assistant tool goes through. The isAdmin re-check runs before
 * input parsing so a non-admin learns nothing about the tool's input shape, even if the
 * registry gate upstream is ever bypassed.
 */
export function defineAdminTool<S extends AdminToolInput>(spec: AdminToolSpec<S>): ToolDefinition {
  return {
    name: spec.name,
    implementation: context => ({
      toolFn: async rawArgs => {
        const result = await execute(spec, rawArgs, context);
        return JSON.stringify(result);
      },
      toolSchema: {
        name: spec.name,
        description: spec.description,
        parameters: toParametersSchema(spec.input),
      },
    }),
  };
}

async function execute<S extends AdminToolInput>(
  spec: AdminToolSpec<S>,
  rawArgs: unknown,
  context: AdminToolContext
): Promise<AdminToolResult> {
  if (context.user.isAdmin !== true) return forbidden;

  const parsed = spec.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_input', message: z.prettifyError(parsed.error) };
  }

  try {
    return await spec.run(parsed.data, context);
  } catch (error) {
    context.logger.error(`Admin assistant tool ${spec.name} failed`, error);
    return { ok: false, error: 'failed', message: 'The tool failed to run.' };
  }
}
