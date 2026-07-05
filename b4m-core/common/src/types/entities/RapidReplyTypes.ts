import { IBaseRepository } from './BaseTypes';
// Centralized enums and helpers (inlined here for simplicity)
export const RapidReplyResponseStylesCommon = ['auto', 'casual', 'professional', 'code'] as const;
export type RapidReplyResponseStyleCommon = (typeof RapidReplyResponseStylesCommon)[number];

export const RapidReplyTransitionModes = ['replace', 'append', 'enhance'] as const;
export type RapidReplyTransitionMode = (typeof RapidReplyTransitionModes)[number];

export const RapidReplyFallbackBehaviors = ['disable', 'continue', 'notify'] as const;
export type RapidReplyFallbackBehavior = (typeof RapidReplyFallbackBehaviors)[number];

/**
 * Represents a mapping between a main model and its rapid reply counterpart
 */
export interface IRapidReplyMapping {
  id: string;
  mainModelId: string;
  rapidModelId: string;
  enabled: boolean;
  priority: number; // For ordering and fallback chains

  // Configuration
  systemPrompt: string;
  maxTokens: number; // 50-500 range
  responseStyle: RapidReplyResponseStyleCommon;
  temperature?: number;

  // Performance settings
  maxLatency?: number; // milliseconds
  fallbackModelId?: string;

  // Conditional logic
  enabledForDomains?: string[]; // ['technical', 'creative', 'research']
  complexityRange?: [number, number]; // [min, max] complexity score
  userTags?: string[]; // Which user tags can use this mapping

  // Metadata
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
  usageCount?: number;
}

/**
 * Represents a rapid reply prompt template
 */
export interface IRapidReplyPrompt {
  id: string;
  name: string;
  description?: string;
  template: string; // Template with {{variables}}
  variables: string[]; // List of supported variables

  // Targeting
  modelPairIds?: string[]; // Specific model pairs this applies to
  domains?: string[]; // Domain-specific prompts
  tones?: RapidReplyResponseStyleCommon[];

  // A/B Testing
  isActive: boolean;
  version: number;
  parentId?: string; // For version history
  testingAllocation?: number; // Percentage of traffic (0-100)

  // Performance metrics
  avgResponseTime?: number;
  successRate?: number;
  userRating?: number;
  usageCount?: number;

  // Metadata
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Global rapid reply settings
 */
export interface IRapidReplySettings {
  id: string;
  enabled: boolean;

  // Feature control
  allowedUserTags: string[]; // ['free', 'pro', 'enterprise', 'developer', 'admin']
  defaultRapidModelId?: string;
  defaultMaxTokens: number;
  defaultResponseStyle: RapidReplyResponseStyleCommon;

  // Performance thresholds
  maxAcceptableLatency: number; // milliseconds
  minSuccessRate: number; // percentage (0-100)

  // Cost management
  dailyCostLimit?: number; // USD
  monthlyCostLimit?: number; // USD
  costWarningThreshold?: number; // percentage of limit

  // UI preferences
  transitionMode: RapidReplyTransitionMode;
  showIndicator: boolean;
  indicatorText?: string;
  fallbackBehavior: RapidReplyFallbackBehavior;

  // Metrics
  metrics?: {
    totalRequests: number;
    successfulRequests: number;
    averageLatency: number;
    lastUpdated: Date;
  };

  // Metadata
  updatedBy: string;
  updatedAt: Date;
}

/**
 * Rapid reply execution result
 */
export interface IRapidReplyResult {
  id: string;
  questId: string;
  sessionId: string;
  userId: string;

  // Request details
  mainModelId: string;
  rapidModelId: string;
  prompt: string;
  systemPrompt: string;

  // Response
  rapidReply: string;
  responseTime: number; // milliseconds
  tokenCount: number;

  // Status
  success: boolean;
  error?: string;
  fallbackUsed?: boolean;
  fallbackModelId?: string;

  // Style analysis
  detectedDomain?: string;
  detectedComplexity?: number;
  appliedStyle: RapidReplyResponseStyleCommon;

  // Cost
  estimatedCost: number; // USD

  // Metadata
  createdAt: Date;
}

/**
 * Audit log for rapid reply configuration changes
 */
export interface IRapidReplyAuditLog {
  id: string;
  action: 'create' | 'update' | 'delete' | 'enable' | 'disable';
  entityType: 'mapping' | 'prompt' | 'settings';
  entityId: string;

  // Change details
  previousValue?: any;
  newValue?: any;
  changedFields?: string[];

  // Context
  userId: string;
  userEmail: string;
  reason?: string;

  // Metadata
  createdAt: Date;
}

/**
 * Repository interfaces
 */
export interface IRapidReplyMappingRepository extends IBaseRepository<IRapidReplyMapping> {
  findByMainModel: (mainModelId: string) => Promise<IRapidReplyMapping | null>;
  findAllEnabled: () => Promise<IRapidReplyMapping[]>;
  findByPriority: () => Promise<IRapidReplyMapping[]>;
  incrementUsageCount: (id: string) => Promise<void>;
}

export interface IRapidReplyPromptRepository extends IBaseRepository<IRapidReplyPrompt> {
  findActiveByModelPair: (modelPairId: string) => Promise<IRapidReplyPrompt[]>;
  findByDomain: (domain: string) => Promise<IRapidReplyPrompt[]>;
  getVersionHistory: (parentId: string) => Promise<IRapidReplyPrompt[]>;
}

export interface IRapidReplySettingsRepository extends IBaseRepository<IRapidReplySettings> {
  getCurrent: () => Promise<IRapidReplySettings>;
  updateCurrent: (settings: Partial<IRapidReplySettings>) => Promise<IRapidReplySettings>;
}

export interface IRapidReplyResultRepository extends IBaseRepository<IRapidReplyResult> {
  findByQuest: (questId: string) => Promise<IRapidReplyResult | null>;
  findBySession: (sessionId: string) => Promise<IRapidReplyResult[]>;
  getMetrics: (
    startDate: Date,
    endDate: Date
  ) => Promise<{
    avgResponseTime: number;
    successRate: number;
    totalCost: number;
    totalRequests: number;
  }>;
}

export interface IRapidReplyAuditLogRepository extends IBaseRepository<IRapidReplyAuditLog> {
  findByEntity: (entityType: string, entityId: string) => Promise<IRapidReplyAuditLog[]>;
  findByUser: (userId: string) => Promise<IRapidReplyAuditLog[]>;
}

/**
 * Document interfaces for MongoDB
 */
export interface IRapidReplyMappingDocument extends IRapidReplyMapping {
  _id: string;
}

export interface IRapidReplyPromptDocument extends IRapidReplyPrompt {
  _id: string;
}

export interface IRapidReplySettingsDocument extends IRapidReplySettings {
  _id: string;
}

export interface IRapidReplyResultDocument extends IRapidReplyResult {
  _id: string;
}

export interface IRapidReplyAuditLogDocument extends IRapidReplyAuditLog {
  _id: string;
}

// Adapter and persistence interfaces (shared contracts)
export interface RapidReplyMappingAdapter {
  id: string;
  rapidModelId: string;
  maxLatency: number;
  systemPrompt: string;
  responseStyle: string;
  enabled?: boolean;
  maxTokens?: number;
}

export interface RapidReplySettingsAdapter {
  enabled: boolean;
  maxAcceptableLatency: number;
  allowedUserTags?: string[];
  transitionMode: RapidReplyTransitionMode;
  showIndicator: boolean;
  fallbackBehavior: RapidReplyFallbackBehavior;
}

export interface RapidReplyResultPersistenceInput {
  questId: string;
  sessionId: string;
  userId: string;
  mainModelId: string;
  rapidModelId: string;
  mappingId: string;
  promptId?: string;
  rapidResponse: {
    content: string;
    tokenCount: number;
    latency: number; // in milliseconds
    cost?: number;
    ttfvt?: number; // in milliseconds
  };
  mainResponse?: {
    content: string;
    tokenCount: number;
    latency: number;
    cost?: number;
  };
  userInteraction: {
    wasShown: boolean;
    wasReplaced: boolean;
    userFeedback?: 'positive' | 'negative' | 'neutral';
    replacementTime?: number; // ms after rapid response
  };
  metrics: {
    totalLatency: number;
    latencySavings: number;
    userExperienceScore?: number; // 1-10
    qualityScore?: number; // 1-10
  };
  status: 'success' | 'failed' | 'timeout' | 'replaced';
  errorMessage?: string;
}
