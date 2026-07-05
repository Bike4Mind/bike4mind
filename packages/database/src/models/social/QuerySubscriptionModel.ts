// Keep in sync with packages/subscriber-fanout/src/querySubscription.ts

import { IMongoDocument } from '@bike4mind/common';
import mongoose from 'mongoose';

export type IQuerySubscriptionSubscriber = {
  // The websocket endpoints that are subscribed to this query
  endpoint: string;
  // The connection ID of the websocket endpoint
  connectionId: string;
  // Client-identified query ID, so we can match and remove them.  Only
  // unique within the scope of the client's endpoint/connectionId
  clientId: string;
  attempts: number;
  errorReason?: string;
  // Timestamp when this subscriber was added
  createdAt?: Date;
};

export type IQuerySubscription = {
  // The collection that the query is scoped to
  collectionName: string;
  // A unique identifier for the query, taken from the SHA256 of the query
  queryId: string;
  // The query, scoped to the user's ability
  query: Record<string, unknown>;
  fields: Record<string, boolean | number>;
  subscribers: IQuerySubscriptionSubscriber[];
  lastChange?: string;
};

export interface IQuerySubscriptionDocument extends IQuerySubscription, IMongoDocument {}

export const QuerySubscriptionSubscriberSchema = new mongoose.Schema<IQuerySubscriptionSubscriber>(
  {
    endpoint: { type: String, required: true },
    connectionId: { type: String, required: true },
    clientId: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    errorReason: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  {
    _id: false,
  }
);

export const QuerySubscriptionSchema = new mongoose.Schema<IQuerySubscriptionDocument>(
  {
    collectionName: { type: String, required: true },
    queryId: { type: String, required: true },
    query: { type: Object, required: true },
    fields: { type: Object, required: true },
    subscribers: {
      type: [QuerySubscriptionSubscriberSchema],
      required: true,
    },
    lastChange: { type: String, required: false },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound index for subscribers fields as recommended by MongoDB Atlas
QuerySubscriptionSchema.index({
  'subscribers.clientId': 1,
  'subscribers.connectionId': 1,
  'subscribers.endpoint': 1,
});

// Index for connectionId lookups during WebSocket disconnects
QuerySubscriptionSchema.index({ 'subscribers.connectionId': 1 });

QuerySubscriptionSchema.index({ queryId: 1 });

export const QuerySubscription: mongoose.Model<IQuerySubscriptionDocument> =
  mongoose.models.QuerySubscription ??
  mongoose.model<IQuerySubscriptionDocument>('QuerySubscription', QuerySubscriptionSchema, 'querySubscriptions');
