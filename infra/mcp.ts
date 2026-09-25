import { execFileSync } from 'child_process';
import { computeMcpContentHash } from '@bike4mind/infra';
import { lambdaVpc } from './vpc';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { router, appUrlForLambdaEnv } from './router';
import { secrets } from './secrets';

// Workspace code the bundle carries, hashed into MCP_VERSION so a code-only change redeploys the
// handler: SST does not notice copyFiles CONTENT changes. Keep in sync with the b4m-core/* entries
// in copyFiles below - a package copied but not listed here stops moving the version. The tiktoken
// wasm is not one of them: it lives under node_modules, so it is untracked and `git ls-tree` has no
// blob to hash, which means MCP_VERSION does not cover it.
// infra/__tests__/contentHashCoverage.test.ts asserts that correspondence in both directions, and
// holds the exclusion to being genuinely untracked. Read one path at a time and hashed in
// @bike4mind/infra, where the ways it can go quietly constant are testable; nothing imports this
// file. See mcpContentHash.ts for which ways and why.
const MCP_CONTENT_HASH = computeMcpContentHash({
  paths: ['b4m-core/mcp', 'b4m-core/common', 'b4m-core/hearth'],
  readTree: path => execFileSync('git', ['ls-tree', '-r', 'HEAD', path]).toString(),
});

export const mcpHandler = new sst.aws.Function('mcpHandler', {
  handler: 'apps/client/server/utils/mcpCall.handler',
  runtime: 'nodejs24.x',
  vpc: lambdaVpc,
  // No provisioned concurrency: see the note on AgentExecutor in infra/agentExecutor.ts. This
  // function carried no `reserved`, so its orphans never blocked a deploy - they accumulated
  // silently (18 of them) and billed for idle capacity nothing could route to.
  link: [secrets.RATE_LIMIT_INGEST_TOKEN],
  logging: {
    retention: '3 days',
  },
  nodejs: {
    // This list must cover the RUNTIME dependency closure of the MCP server
    // children spawned by this handler (they import @bike4mind/common + the
    // relevant @bike4mind/mcp tool modules). copyFiles brings the workspace
    // *code*; `install` brings those packages' npm *deps* (SST installs them into
    // node_modules with their transitive deps). Keep in sync when a child gains a
    // new runtime dependency. NOTE: @anthropic-ai/sdk is intentionally NOT here -
    // it is a type-only import in the MCP client, erased at build.
    install: ['@modelcontextprotocol/sdk', '@octokit/rest', 'zod', 'dayjs', 'unzipper', 'axios'],
    esbuild: {
      // Mark workspace packages as external to prevent bundling, allowing runtime resolution
      external: ['@bike4mind/mcp', '@bike4mind/common'],
    },
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
    APP_URL: router ? appUrlForLambdaEnv() : 'http://localhost:3000',
    // Content hash triggers Lambda rebuild when MCP or Common package code changes
    MCP_VERSION: MCP_CONTENT_HASH,
  },
  // Copy workspace packages to node_modules structure for proper ESM resolution
  // Node.js ESM requires @scope/package structure at runtime, not workspace paths
  copyFiles: [
    {
      from: 'apps/client/node_modules/tiktoken/tiktoken_bg.wasm',
      to: 'tiktoken_bg.wasm',
    },
    {
      from: 'b4m-core/mcp/dist',
      to: 'node_modules/@bike4mind/mcp/dist',
    },
    {
      from: 'b4m-core/mcp/package.json',
      to: 'node_modules/@bike4mind/mcp/package.json',
    },
    {
      from: 'b4m-core/common/dist',
      to: 'node_modules/@bike4mind/common/dist',
    },
    {
      from: 'b4m-core/common/package.json',
      to: 'node_modules/@bike4mind/common/package.json',
    },
    // Copied, not installed: hearth is workspace:*, so `install` cannot fetch it. The common
    // barrel imports it at module load, and an unresolvable import kills the child before the
    // stdio handshake - surfacing only as `MCP error -32000: Connection closed`.
    {
      from: 'b4m-core/hearth/dist',
      to: 'node_modules/@bike4mind/hearth/dist',
    },
    {
      from: 'b4m-core/hearth/package.json',
      to: 'node_modules/@bike4mind/hearth/package.json',
    },
  ],
});
