import { IMcpServerDocument, IMcpServerRepository, McpServerName } from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { IMongoDocument } from '@bike4mind/common';

const McpServerSchema = new Schema<IMcpServerDocument>(
  {
    name: { type: String, enum: Object.values(McpServerName), required: true },
    userId: { type: String, required: true },
    envVariables: [
      {
        key: { type: String, required: true },
        value: { type: String, required: true },
      },
    ],
    enabled: { type: Boolean, required: true },
    tools: { type: [String], default: [] },
    toolSchemas: { type: Schema.Types.Mixed, default: undefined },
    metadata: {
      type: {
        githubLogin: { type: String },
        scope: { type: String },
        connectedAt: { type: String },
        disconnectedAt: { type: String },
        selectedRepositories: [
          {
            fullName: { type: String, required: true },
            owner: { type: String, required: true },
            repo: { type: String, required: true },
          },
        ],
        webhooks: {
          type: {
            github: {
              type: {
                routingToken: { type: String, required: true },
                secret: { type: String, required: true },
                subscribedEvents: { type: [String], default: [] },
                repos: { type: [String], default: [] },
                createdAt: { type: String, required: true },
                lastDeliveryAt: { type: String },
              },
              required: false,
            },
          },
          required: false,
        },
      },
      required: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Index for webhook routing token lookups (used on every webhook delivery)
McpServerSchema.index(
  { 'metadata.webhooks.github.routingToken': 1 },
  { sparse: true, name: 'github_webhook_routing_token' }
);

export interface IMcpServerModel extends Model<IMcpServerDocument & IMongoDocument> {}
export const McpServer: IMcpServerModel =
  mongoose.models.McpServer ?? model<IMcpServerDocument>('McpServer', McpServerSchema);

class McpServerRepository extends BaseRepository<IMcpServerDocument & IMongoDocument> implements IMcpServerRepository {
  /**
   * Find an MCP server by GitHub webhook routing token
   *
   * @param routingToken - The X-Webhook-Token header value
   * @returns MCP server document if found, null otherwise
   */
  async findByGitHubWebhookToken(routingToken: string): Promise<(IMcpServerDocument & IMongoDocument) | null> {
    return this.findOne({ 'metadata.webhooks.github.routingToken': routingToken });
  }

  /**
   * Update the lastDeliveryAt timestamp for a GitHub webhook
   *
   * @param id - MCP server document ID
   * @returns Updated document
   */
  async updateGitHubWebhookLastDelivery(id: string): Promise<(IMcpServerDocument & IMongoDocument) | null> {
    return this.model.findByIdAndUpdate(
      id,
      { $set: { 'metadata.webhooks.github.lastDeliveryAt': new Date().toISOString() } },
      { new: true }
    );
  }
}
export const mcpServerRepository = new McpServerRepository(McpServer);

export default McpServer;
