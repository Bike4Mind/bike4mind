import * as z from 'zod';
import type { IGitHubWebhookConfig, IMcpServerDocument } from '../types/entities/McpServerTypes';
import { passthroughShape } from './responseShape';

type McpServerMetadata = NonNullable<IMcpServerDocument['metadata']>;

/**
 * Server-only MCP server fields, never sent to the client:
 * - `envVariables[].value`: the integration credentials (encrypted at rest, decrypted only to call
 *   the MCP handler). The client gets the keys alone; PUT keeps a stored value when its key comes
 *   back blank (apps/client/pages/api/mcp-servers/[id]/index.ts).
 * - `metadata.webhooks.github.secret`: the HMAC secret that authenticates inbound deliveries,
 *   revealed only through the dedicated webhook routes under pages/api/mcp-servers/[id]/webhooks.
 */
export const MCP_SERVER_ENV_VARIABLE_WITHHELD_FIELDS = ['value'] as const;
export const MCP_SERVER_GITHUB_WEBHOOK_WITHHELD_FIELDS = ['secret'] as const;

// Held to IGitHubWebhookConfig: a new field fails the build here until it is classified.
const GITHUB_WEBHOOK_RESPONSE_FIELDS = {
  routingToken: true,
  subscribedEvents: true,
  repos: true,
  createdAt: true,
  lastDeliveryAt: true,
} as const satisfies Record<
  Exclude<keyof IGitHubWebhookConfig, (typeof MCP_SERVER_GITHUB_WEBHOOK_WITHHELD_FIELDS)[number]>,
  true
>;

// Held to the metadata shape; `webhooks` is listed for the key check but replaced below so the
// secret is stripped one level down rather than passed through with its parent.
const METADATA_RESPONSE_FIELDS = {
  githubLogin: true,
  githubUserId: true,
  scope: true,
  connectedAt: true,
  disconnectedAt: true,
  selectedRepositories: true,
  webhooks: true,
} as const satisfies Record<keyof McpServerMetadata, true>;

const metadataResponseSchema = z.object({
  ...passthroughShape(METADATA_RESPONSE_FIELDS),
  webhooks: z.object({ github: z.object(passthroughShape(GITHUB_WEBHOOK_RESPONSE_FIELDS)).nullish() }).nullish(),
});

// Held to IMcpServerDocument: a new field fails the build here until it is listed.
const MCP_SERVER_RESPONSE_FIELDS = {
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  userId: true,
  envVariables: true,
  tools: true,
  toolSchemas: true,
  toolSchemasFetchedAt: true,
  enabled: true,
  metadata: true,
} as const satisfies Record<keyof IMcpServerDocument, true>;

/** An MCP server as returned by the SPA's /api/mcp-servers routes. */
export const mcpServerResponseSchema = z.object({
  ...passthroughShape(MCP_SERVER_RESPONSE_FIELDS),
  envVariables: z.array(z.object({ key: z.string() })),
  metadata: metadataResponseSchema.nullish(),
});
