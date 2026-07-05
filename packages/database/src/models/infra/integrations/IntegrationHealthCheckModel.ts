import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

// --- Types & Constants ---

export const INTEGRATION_HEALTH_INTEGRATIONS = ['slack', 'github', 'jira', 'confluence'] as const;
export type IntegrationName = (typeof INTEGRATION_HEALTH_INTEGRATIONS)[number];

export type IntegrationHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export const INTEGRATION_HEALTH_THRESHOLDS = {
  /** Latency above this (ms) marks status as degraded */
  LATENCY_WARNING_MS: 2000,
  /** Latency above this (ms) marks status as unhealthy */
  LATENCY_CRITICAL_MS: 5000,
  /** Consecutive failures before alerting */
  FAILURE_ALERT_THRESHOLD: 3,
  /** TTL for health check records (25 hours - keeps 24h + buffer) */
  RECORD_TTL_MS: 25 * 60 * 60 * 1000,
} as const;

// --- Document Interface ---

export interface IIntegrationHealthCheckDocument extends IMongoDocument {
  integration: IntegrationName;
  status: IntegrationHealthStatus;
  latencyMs: number;
  statusCode: number | null;
  error: string | null;
  /** True when the failure is due to missing config (no token/connection), not an actual API outage */
  configMissing: boolean;
  checkedAt: Date;
  expiresAt: Date;
  metadata: {
    rateLimitRemaining?: number;
    rateLimitLimit?: number;
    rateLimitReset?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

// --- Schema ---

const IntegrationHealthCheckSchema = new mongoose.Schema<IIntegrationHealthCheckDocument>(
  {
    integration: {
      type: String,
      enum: INTEGRATION_HEALTH_INTEGRATIONS,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['healthy', 'degraded', 'unhealthy'],
      required: true,
    },
    latencyMs: { type: Number, required: true },
    statusCode: { type: Number, default: null },
    error: { type: String, default: null },
    configMissing: { type: Boolean, default: false },
    checkedAt: { type: Date, required: true, default: () => new Date(), index: true },
    expiresAt: { type: Date, required: true },
    metadata: {
      rateLimitRemaining: { type: Number },
      rateLimitLimit: { type: Number },
      rateLimitReset: { type: Number },
    },
  },
  { timestamps: true }
);

// TTL index - auto-delete records after expiresAt
IntegrationHealthCheckSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for dashboard queries: latest checks per integration
IntegrationHealthCheckSchema.index({ integration: 1, checkedAt: -1 });

// --- Model ---

export const IntegrationHealthCheck: Model<IIntegrationHealthCheckDocument> =
  mongoose.models.IntegrationHealthCheck ||
  mongoose.model<IIntegrationHealthCheckDocument>('IntegrationHealthCheck', IntegrationHealthCheckSchema);

// --- Repository ---

export class IntegrationHealthCheckRepository extends BaseRepository<IIntegrationHealthCheckDocument> {
  constructor(model: Model<IIntegrationHealthCheckDocument>) {
    super(model);
  }

  /**
   * Get the most recent health check for each integration.
   */
  async getLatestPerIntegration(): Promise<IIntegrationHealthCheckDocument[]> {
    return this.model
      .aggregate([
        { $sort: { checkedAt: -1 } },
        { $group: { _id: '$integration', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
      ])
      .exec();
  }

  /**
   * Get recent health checks for a specific integration.
   */
  async getRecentByIntegration(integration: IntegrationName, limit = 288): Promise<IIntegrationHealthCheckDocument[]> {
    return this.model.find({ integration }).sort({ checkedAt: -1 }).limit(limit).exec();
  }

  /**
   * Get the last N checks for an integration (used for failure streak detection).
   */
  async getLastNChecks(integration: IntegrationName, n: number): Promise<IIntegrationHealthCheckDocument[]> {
    return this.model.find({ integration }).sort({ checkedAt: -1 }).limit(n).exec();
  }

  /**
   * Compute success rate for an integration over the last 24 hours.
   */
  async getSuccessRate(integration: IntegrationName): Promise<{ total: number; successful: number; rate: number }> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const results = await this.model
      .aggregate([
        { $match: { integration, checkedAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            successful: { $sum: { $cond: [{ $eq: ['$status', 'healthy'] }, 1, 0] } },
          },
        },
      ])
      .exec();

    if (!results.length) {
      return { total: 0, successful: 0, rate: 0 };
    }

    const { total, successful } = results[0];
    return { total, successful, rate: total > 0 ? successful / total : 0 };
  }

  /**
   * Record a new health check result.
   */
  async recordCheck(data: {
    integration: IntegrationName;
    status: IntegrationHealthStatus;
    latencyMs: number;
    statusCode?: number | null;
    error?: string | null;
    configMissing?: boolean;
    metadata?: IIntegrationHealthCheckDocument['metadata'];
  }): Promise<IIntegrationHealthCheckDocument> {
    const now = new Date();
    return this.model.create({
      ...data,
      statusCode: data.statusCode ?? null,
      error: data.error ?? null,
      configMissing: data.configMissing ?? false,
      metadata: data.metadata ?? {},
      checkedAt: now,
      expiresAt: new Date(now.getTime() + INTEGRATION_HEALTH_THRESHOLDS.RECORD_TTL_MS),
    });
  }
}

export const integrationHealthCheckRepository = new IntegrationHealthCheckRepository(IntegrationHealthCheck);

// Circuit Breaker Override - manual admin control per integration

export type CircuitBreakerMode = 'auto' | 'force_block' | 'force_open';

export interface IIntegrationCircuitOverrideDocument extends IMongoDocument {
  integration: IntegrationName;
  mode: CircuitBreakerMode;
  /** Admin user ID who set the override */
  setBy: string;
  setAt: Date;
  /** Optional admin note explaining why */
  reason?: string;
}

const IntegrationCircuitOverrideSchema = new mongoose.Schema<IIntegrationCircuitOverrideDocument>(
  {
    integration: {
      type: String,
      enum: INTEGRATION_HEALTH_INTEGRATIONS,
      required: true,
      unique: true,
    },
    mode: {
      type: String,
      enum: ['auto', 'force_block', 'force_open'],
      required: true,
      default: 'auto',
    },
    setBy: { type: String, required: true },
    setAt: { type: Date, required: true, default: () => new Date() },
    reason: { type: String },
  },
  { timestamps: true }
);

export const IntegrationCircuitOverride: Model<IIntegrationCircuitOverrideDocument> =
  mongoose.models.IntegrationCircuitOverride ||
  mongoose.model<IIntegrationCircuitOverrideDocument>('IntegrationCircuitOverride', IntegrationCircuitOverrideSchema);

export class IntegrationCircuitOverrideRepository extends BaseRepository<IIntegrationCircuitOverrideDocument> {
  constructor(model: Model<IIntegrationCircuitOverrideDocument>) {
    super(model);
  }

  /**
   * Get the override for a specific integration, or null if none is set (defaults to 'auto').
   */
  async getOverride(integration: IntegrationName): Promise<IIntegrationCircuitOverrideDocument | null> {
    return this.model.findOne({ integration }).exec();
  }

  /**
   * Get overrides for all integrations.
   */
  async getAllOverrides(): Promise<IIntegrationCircuitOverrideDocument[]> {
    return this.model.find().exec();
  }

  /**
   * Set or update the circuit breaker override for an integration.
   * Upserts: creates if it doesn't exist, updates if it does.
   */
  async setOverride(data: {
    integration: IntegrationName;
    mode: CircuitBreakerMode;
    setBy: string;
    reason?: string;
  }): Promise<IIntegrationCircuitOverrideDocument> {
    const result = await this.model.findOneAndUpdate(
      { integration: data.integration },
      {
        mode: data.mode,
        setBy: data.setBy,
        setAt: new Date(),
        reason: data.reason,
      },
      { upsert: true, new: true }
    );
    return result;
  }
}

export const integrationCircuitOverrideRepository = new IntegrationCircuitOverrideRepository(
  IntegrationCircuitOverride
);
