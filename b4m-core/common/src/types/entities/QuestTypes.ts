import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { IChatHistoryItemDocument } from './SessionTypes';

export type QuestItem = {
  quest: string; // The description of the quest
  tool: string; // The name of the tool to be used
  details: string;
  reason: string; // The reason why this tool is recommended
  parameters: Record<string, unknown>; // The parameters for the tool function
};

export interface IChatHistoryItemRepository extends IBaseRepository<IChatHistoryItemDocument> {
  findAllBySessionId: (sessionId: string) => Promise<IChatHistoryItemDocument[]>;
  findAllBySessionIdAndLessThanOrEqualToTimestamp(
    sessionId: string,
    timestamp: Date
  ): Promise<IChatHistoryItemDocument[]>;
  findAllBySessionIdAndGreaterThanOrEqualToTimestamp(
    sessionId: string,
    timestamp: Date
  ): Promise<IChatHistoryItemDocument[]>;
  getMostRecentChatHistory: (sessionId: string, limit: number) => Promise<IChatHistoryItemDocument[]>;
  findBySessionIdAndId: (sessionId: string, id: string) => Promise<IChatHistoryItemDocument | null>;
  // Lightweight method for status checks
  findByIdWithStatus: (id: string) => Promise<Pick<IChatHistoryItemDocument, 'id' | 'status'> | null>;
  // Flag a quest as stopped so an in-flight pipeline's cancellation watcher aborts it.
  markStopped: (id: string) => Promise<void>;
  // Cheap existence check - used by the voice proxy to decide whether to emit
  // an initial buffer chunk for brand-new sessions (no prior turns).
  existsBySessionId: (sessionId: string) => Promise<boolean>;
}

/**
 * Valid status values for sub-quests
 */
export type SubQuestStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'deleted';

/**
 * Status of a review gate on a sub-quest
 */
export type ReviewGateStatus = 'pending' | 'approved' | 'rejected';

/**
 * A blocker preventing progress on the quest plan
 */
export type QuestBlocker = {
  id: string;
  description: string;
  relatedQuestId?: string;
  relatedSubQuestId?: string;
  createdAt: Date;
  resolvedAt?: Date;
  resolution?: string;
};

/**
 * A recorded decision with rationale for audit trail
 */
export type QuestDecision = {
  id: string;
  description: string;
  rationale: string;
  madeBy: string; // 'ai' | userId
  madeAt: Date;
  relatedQuestId?: string;
  relatedSubQuestId?: string;
};

/**
 * Structured handoff state for session continuity.
 * Written by the AI at session end so the next session can resume with full context.
 */
export type QuestHandoff = {
  summary: string;
  nextSteps: string[];
  pendingDecisions: string[];
  blockers: string[];
  lastUpdatedBy: string; // session ID
  updatedAt: Date;
};

// QuestMasterData interface for frontend display
export interface QuestMasterData {
  id: string;
  title: string;
  description: string;
  complexity: string;
  subQuests: {
    id: string;
    title: string;
    status: SubQuestStatus;

    /**
     * Associated quest(chat history item) id that performed this sub-quest
     */
    questId?: string;

    /**
     * Timestamp when this sub-quest was started (for time tracking)
     */
    startedAt?: number;

    /**
     * Evidence of what was accomplished when this sub-quest was completed.
     * Links to artifacts, descriptions of output, or references to results.
     */
    evidence?: string;

    /**
     * If true, the AI should stop at this sub-quest and wait for human approval
     * before proceeding to the next step.
     */
    reviewGate?: boolean;

    /**
     * Status of the review gate (only meaningful when reviewGate is true)
     */
    reviewStatus?: ReviewGateStatus;

    /**
     * Human feedback on the review gate
     */
    reviewNote?: string;
  }[];
}

export interface IQuestMasterPlan {
  /**
   * The ID of the notebook where the quest plan was created
   */
  notebookId: string;

  goal: string;

  quests: QuestMasterData[];

  /**
   * User who owns this quest plan (for cross-session access)
   */
  userId?: string;

  /**
   * Visibility scope for the quest plan
   */
  visibility?: 'session' | 'user' | 'team' | 'public';

  /**
   * Current state of the quest plan
   */
  state?: 'draft' | 'active' | 'paused' | 'completed' | 'archived';

  /**
   * Last time this quest plan was accessed
   */
  lastAccessedAt?: Date;

  /**
   * Track which sessions have accessed this quest plan
   */
  sessionHistory?: Array<{
    sessionId: string;
    lastAccessed: Date;
    actions: number;
  }>;

  /**
   * Metrics for tracking progress and time
   */
  metrics?: {
    totalTimeSpent: number;
    completionRate: number;
    subQuestsCompleted: number;
    subQuestsTotal: number;
    lastProgress?: Date;
  };

  /**
   * User-defined tags for organization
   */
  tags?: string[];

  /**
   * Priority level
   */
  priority?: 'low' | 'medium' | 'high' | 'critical';

  /**
   * For cloned/forked plans
   */
  parentPlanId?: string;

  /**
   * Users who have access (for team collaboration)
   */
  sharedWith?: string[];

  /**
   * Structured handoff state for session continuity.
   * Written at session end so the next session resumes with full context.
   */
  handoff?: QuestHandoff;

  /**
   * Active and resolved blockers preventing progress
   */
  blockers?: QuestBlocker[];

  /**
   * Decision log with rationale for audit trail
   */
  decisions?: QuestDecision[];
}

export interface IQuestMasterPlanDocument extends IQuestMasterPlan, IMongoDocument {}

export interface IQuestMasterPlanRepository extends IBaseRepository<IQuestMasterPlanDocument> {
  findByNotebookId(notebookId: string): Promise<IQuestMasterPlanDocument[]>;

  updateTaskStatus(
    questMasterPlanId: string,
    mainQuestId: string,
    subQuestId: string,
    status: QuestMasterData['subQuests'][number]['status']
  ): Promise<IQuestMasterPlanDocument | null>;

  getSubQuest(
    questMasterPlanId: string,
    mainQuestId: string,
    subQuestId: string
  ): Promise<QuestMasterData['subQuests'][number] | null>;

  // New methods for cross-session persistence
  findByUserId(
    userId: string,
    options?: {
      state?: string;
      tags?: string[];
      limit?: number;
      offset?: number;
      includeQuests?: boolean;
    }
  ): Promise<IQuestMasterPlanDocument[]>;

  // Optimized method that returns plans, total count, and stats
  findByUserIdWithCount(
    userId: string,
    options?: {
      state?: string;
      tags?: string[];
      limit?: number;
      offset?: number;
      includeQuests?: boolean;
    }
  ): Promise<{
    plans: IQuestMasterPlanDocument[];
    total: number;
    stats: { active: number; paused: number; completed: number; archived: number; totalTimeSpent: number };
  }>;

  findAccessibleByUserId(
    userId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<IQuestMasterPlanDocument[]>;

  continueInSession(planId: string, sessionId: string, userId: string): Promise<IQuestMasterPlanDocument>;

  updateQuestProgress(
    planId: string,
    questId: string,
    subQuestId: string,
    updates: {
      status?: SubQuestStatus;
      timeSpent?: number;
      chatMessageId?: string;
      startedAt?: number;
      evidence?: string;
    },
    options?: {
      autoResumeIfPaused?: boolean;
    }
  ): Promise<IQuestMasterPlanDocument | null>;

  updateMetrics(planId: string): Promise<IQuestMasterPlanDocument | null>;

  // Validates if a state transition is allowed
  isValidStateTransition(fromState: string, toState: string): boolean;

  // Atomically updates notebookId only if it matches expected value (prevents race conditions)
  atomicUpdateNotebookId(planId: string, expectedNotebookId: string, newNotebookId: string): Promise<boolean>;

  // Durable workflow state methods

  /**
   * Write or update the handoff state for session continuity.
   * Called at session end so the next session can resume with full context.
   */
  updateHandoff(planId: string, handoff: QuestHandoff): Promise<IQuestMasterPlanDocument | null>;

  /**
   * Add a blocker to the plan
   */
  addBlocker(planId: string, blocker: QuestBlocker): Promise<IQuestMasterPlanDocument | null>;

  /**
   * Resolve an existing blocker
   */
  resolveBlocker(planId: string, blockerId: string, resolution: string): Promise<IQuestMasterPlanDocument | null>;

  /**
   * Record a decision with rationale for audit trail
   */
  addDecision(planId: string, decision: QuestDecision): Promise<IQuestMasterPlanDocument | null>;

  /**
   * Update the review gate status on a sub-quest (approve/reject with feedback)
   */
  updateReviewGate(
    planId: string,
    questId: string,
    subQuestId: string,
    reviewStatus: ReviewGateStatus,
    reviewNote?: string
  ): Promise<IQuestMasterPlanDocument | null>;
}
