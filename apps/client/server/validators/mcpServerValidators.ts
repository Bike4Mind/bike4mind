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
  // Validated against the enum rather than merely typed as a string. The schema declares
  // `enum: Object.values(McpServerName)`, and every write path here does enforce it -- the PUT
  // passes `runValidators: true`, and `Model.create` runs validators by default -- but each one
  // enforces it as a 500 (a ValidationError out of mongoose), where a rejected body value should
  // be a 400. The POST's update-existing branch goes through `BaseModel.update`, which does not
  // pass `runValidators`, so there it is not enforced at all.
  name: z.enum(McpServerName),
  // Required because encryptEnvVariables() maps over it unconditionally: a body without it
  // throws a TypeError today, so declaring it required turns that 500 into a 400 and breaks
  // no call that currently works.
  envVariables: z.array(z.object({ key: z.string(), value: z.string() })),
  enabled: z.boolean().optional(),
};

/**
 * PUT: `name` is optional because the route resolves the server by id, not by name.
 *
 * `envVariables` is a full replacement, not a patch - the handler `$set`s whatever arrives, so a
 * body carrying a subset drops the rest. That is why it stays required here: an omitted array
 * would have to mean either "clear them" or "leave them alone", and a 400 asking for the whole
 * set is clearer than picking one silently.
 */
export const mcpServerUpdateBodySchema = z.object({
  ...mcpServerFields,
  name: mcpServerFields.name.optional(),
});

/**
 * POST: `name` is required because it is the upsert lookup key -- the route's first statement
 * filters on it, so a missing name is not a create, it is a `findOne({ name: undefined })`.
 *
 * `enabled` stays optional even though the schema marks it `required: true`, because the two
 * branches behind this route disagree. On the create branch, omitting it is already a 500 from
 * mongoose. On the update-existing branch it is a working call today: `_castUpdate` strips
 * `enabled: undefined` out of the `$set` before casting (verified on mongoose 8.24.1), so
 * `POST {name, envVariables}` against an existing server leaves the stored value alone and
 * answers 200. Requiring it here would turn that into a 400 -- a regression for any API-key
 * caller that omits it, even though both in-app callers send the full triple.
 */
export const mcpServerCreateBodySchema = z.object(mcpServerFields);
