import { execSync } from 'child_process';
import { lambdaVpc } from './vpc';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { router } from './router';
import { secrets } from './secrets';

// Calculate content hash from git tree - changes immediately when MCP/Common code changes
// Matches the content hash pattern used in ci.yml for caching
// This is a workaround for SST not detecting copyFiles content changes
const MCP_CONTENT_HASH = execSync(
  "git ls-tree -r HEAD b4m-core/mcp b4m-core/common | awk '{print $3}' | sort | md5sum | awk '{print $1}'"
)
  .toString()
  .trim()
  .slice(0, 8);

export const mcpHandler = new sst.aws.Function('mcpHandler', {
  handler: 'apps/client/server/utils/mcpCall.handler',
  runtime: 'nodejs24.x',
  vpc: lambdaVpc,
  // Enable versioning to create published versions (required for provisioned concurrency)
  versioning: true,
  concurrency: ['production', 'dev'].includes($app.stage)
    ? {
        provisioned: 1,
      }
    : undefined,
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
    APP_URL: router ? router.url : 'http://localhost:3000',
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
  ],
});
