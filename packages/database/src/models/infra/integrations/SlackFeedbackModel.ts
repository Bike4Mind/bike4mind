import mongoose, { Schema } from 'mongoose';

export interface SlackFeedbackChannelRecord {
  _id: string;
  organizationId: string;
  workspaceId: string;
  slackTeamId: string;
  channelId: string;
  destinationId: string;
  emoji: string;
  enabled: boolean;
  configuredBy: string;
}

const channelSchema = new Schema<SlackFeedbackChannelRecord>(
  {
    _id: { type: String, required: true },
    organizationId: { type: String, required: true },
    workspaceId: { type: String, required: true },
    slackTeamId: { type: String, required: true },
    channelId: { type: String, required: true },
    destinationId: { type: String, required: true },
    emoji: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    configuredBy: { type: String, required: true },
  },
  { timestamps: true }
);
channelSchema.index({ organizationId: 1, workspaceId: 1, enabled: 1 });

export interface SlackFeedbackDeliveryRecord {
  _id: string;
  organizationId: string;
  workspaceId: string;
  slackTeamId: string;
  channelId: string;
  messageTs: string;
  reactor: string;
  destinationId: string;
  state: 'claimed' | 'ignored' | 'limited' | 'sending' | 'sent' | 'failed';
  statuses: string[];
}

const deliverySchema = new Schema<SlackFeedbackDeliveryRecord>(
  {
    _id: { type: String, required: true },
    organizationId: { type: String, required: true },
    workspaceId: { type: String, required: true },
    slackTeamId: { type: String, required: true },
    channelId: { type: String, required: true },
    messageTs: { type: String, required: true },
    reactor: { type: String, required: true },
    destinationId: { type: String, required: true },
    state: { type: String, required: true, enum: ['claimed', 'ignored', 'limited', 'sending', 'sent', 'failed'] },
    statuses: { type: [String], default: [] },
  },
  { timestamps: true }
);
deliverySchema.index({ organizationId: 1, createdAt: -1 });

// Permanent message claims retain dedupe even after operational audit logs expire.
export const SlackFeedbackChannel =
  (mongoose.models.SlackFeedbackChannel as mongoose.Model<SlackFeedbackChannelRecord>) ||
  mongoose.model<SlackFeedbackChannelRecord>('SlackFeedbackChannel', channelSchema);
export const SlackFeedbackDelivery =
  (mongoose.models.SlackFeedbackDelivery as mongoose.Model<SlackFeedbackDeliveryRecord>) ||
  mongoose.model<SlackFeedbackDeliveryRecord>('SlackFeedbackDelivery', deliverySchema);
