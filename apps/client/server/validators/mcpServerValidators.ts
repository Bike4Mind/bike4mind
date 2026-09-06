import { McpServerName } from '@bike4mind/common';
import { z } from 'zod';

// Shared by the two MCP-server write routes: PUT `pages/api/mcp-servers/[id]/index.ts` and POST
// `pages/api/mcp-servers/index.ts`. Both take the same three fields, and neither is admin-gated
// (the only check is an IDOR ownership test), so an authenticated caller reaches mongoose with
// whatever it sends. `enabled` is Boolean-typed and `name` is a String path, and both filters and
// update payloads cast before validators run, so 2, {} or [] on the first and an array or object
// on the second throw a `CastError` -- a 500 logged at `error` rather than the 404 it used to be.
//
// z.boolean() rather than a coercion, deliberately: coercing would accept 2 and hand it to
// mongoose, which is the thing being guarded against.
const mcpServerFields = {
  // Validated against the enum, not merely typed as a string, because the two write paths
  // disagree about whether the schema's `enum: Object.values(McpServerName)` is enforced at all.
  // `Model.create` runs validators, so POST's create branch answers 500 on an unknown name; both
  // update branches reach `findOneAndUpdate` without `runValidators`, and mongoose skips
  // validators on update queries by default, so there an unknown name is simply written with a
  // 200. Checking it here makes both a 400.
  name: z.enum(McpServerName),
  // Required because encryptEnvVariables() maps over it unconditionally: a body without it
  // throws a TypeError today, so declaring it required turns that 500 into a 400 and breaks
  // no call that currently works.
  envVariables: z.array(z.object({ key: z.string(), value: z.string() })),
  enabled: z.boolean().optional(),
};

/** PUT: `name` is optional because the route resolves the server by id, not by name. */
export const mcpServerUpdateBodySchema = z.object({
  ...mcpServerFields,
  name: mcpServerFields.name.optional(),
});

/**
 * POST: `name` is both the upsert lookup key and required by the schema, and `enabled` is
 * `required: true` as well -- omitting either fails validation on the create branch with a 500
 * today, so requiring them here turns that into a 400 and breaks no working call.
 */
export const mcpServerCreateBodySchema = z.object({
  ...mcpServerFields,
  enabled: z.boolean(),
});
