# @bike4mind/mcp-server

The Bike4Mind MCP tool framework, shared by the stdio server (`b4m mcp serve`) and the hosted `/mcp` route. It does no
I/O of its own: everything transport-specific arrives through the `ToolContext`.

```ts
import { registerBike4MindTools, createStdioTransport, parseToolsets } from '@bike4mind/mcp-server';

registerBike4MindTools(server, {
  transport: createStdioTransport({ baseUrl, apiKey }),
  kind: 'stdio', // or 'http'
  scopes: 'all', // the key's scopes, or 'all' when unknown / keyless
  exposureCeiling: 'private',
  toolsets: parseToolsets(process.env.TOOLSETS), // `?toolsets=` / `--toolsets`
  waitBudgetSeconds: 900,
  baseUrl,
});
```

Tools are filtered by toolset and scope **before** registration, so listing is deterministic and needs no network.

## Adding a tool

1. Declare it with `defineTool` in `src/toolsets/<toolset>/`. The four annotation hints are required.
2. Reach the API only through `ctx.transport.call(operation, ...)`. Add the route to `OPERATIONS`; a route with a
   contract in `@bike4mind/sdk` sets `sdkOperationId`, any other route is built by `buildGuardedUrl`.
3. Validate ids with the validators in `src/ids.ts` before any transport call.
4. Add the tool to `ALL_TOOLS` in `src/register.ts`. A new toolset also needs an entry in `TOOLSETS`.

`src/registry.rules.test.ts` runs `checkToolDesign` over every registered tool, so a tool that breaks a rule fails the
build. The rules: `verb_noun` snake_case name, a title, all four hints, an `outputSchema`, a description of 600
characters or fewer, no `confirm` input (confirmation is a `needs_confirmation` result), list tools take `limit`
(default 20) and `cursor`, and a tool that returns `untrusted_*` fields says they are data, not instructions.

## Jobs

Long-running work is an opaque `<kind>:<id>` string. `wait_for_job` and `stop_job` dispatch on the kind through
`src/jobs/registry.ts`. Only `confirmation` is wired.
