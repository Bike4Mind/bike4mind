import mongoose, { Model, Schema, model } from 'mongoose';
import {
  IAgent,
  IAgentDocument,
  IAgentMethods,
  IAgentRepository,
  IMemoryEntry,
  IPendingAgentMessage,
  IWorldMemoryEntry,
} from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { ShareableDocumentSchema, ShareableDocumentRepository } from '../content/SharableDocumentModel';

const ModelName = 'Agent';

export const THOROUGHNESS_LEVELS = ['quick', 'medium', 'very_thorough'] as const;
export type ThoroughnessLevel = (typeof THOROUGHNESS_LEVELS)[number];

// Upper bound mirrors the WS dispatch cap in `agentExecute.ts` so a stored
// value can never exceed what the executor will actually honor.
const MAX_ITERATIONS_UPPER_BOUND = 100;

const MaxIterationsSchema = new mongoose.Schema(
  {
    quick: { type: Number, required: true, min: 1, max: MAX_ITERATIONS_UPPER_BOUND },
    medium: { type: Number, required: true, min: 1, max: MAX_ITERATIONS_UPPER_BOUND },
    very_thorough: { type: Number, required: true, min: 1, max: MAX_ITERATIONS_UPPER_BOUND },
  },
  { _id: false }
);

export interface IAgentModel extends Model<IAgentDocument, {}, IAgentMethods> {}

export class AgentRepository extends BaseRepository<IAgentDocument> implements IAgentRepository {
  shareable: IAgentRepository['shareable'];

  constructor(
    private agentModel: IAgentModel,
    extensions: {
      shareable: IAgentRepository['shareable'];
    }
  ) {
    super(agentModel);
    this.agentModel = agentModel;
    this.shareable = extensions.shareable;
  }

  async findByIdAndUserId(id: string, userId: string) {
    const result = await this.agentModel.findOne({ _id: id, userId });
    return result?.toJSON() ?? null;
  }

  async findByTriggerWords(triggerWords: string[], userId: string) {
    const result = await this.agentModel.find({
      $or: [{ userId }, { 'users.userId': userId }],
      triggerWords: { $in: triggerWords },
      deletedAt: null,
    });

    return result.map(doc => doc.toJSON());
  }

  async searchAccessible(
    userId: string,
    search: string,
    filters: {
      isPublic?: boolean;
      query?: Record<string, unknown>;
    },
    pagination: {
      page: number;
      limit: number;
    },
    orderBy: {
      by: string;
      direction: string;
    }
  ) {
    const queryConditions: Record<string, unknown> = {
      $or: [
        { userId }, // User is the owner
        { 'users.userId': userId }, // User is a shared member
      ],
      ...(filters.query || {}),
      deletedAt: null,
    };

    if (search) {
      queryConditions.$and = [
        {
          $or: [
            { name: { $regex: escapeRegex(search), $options: 'si' } },
            { description: { $regex: escapeRegex(search), $options: 'si' } },
            { triggerWords: { $regex: escapeRegex(search), $options: 'si' } },
          ],
        },
      ];
    }

    const query = this.agentModel.find(queryConditions);
    const total = await this.agentModel.countDocuments(queryConditions);

    query.skip((pagination.page - 1) * pagination.limit).limit(pagination.limit + 1);
    query.sort({ [orderBy.by]: orderBy.direction === 'asc' ? 1 : -1 });

    const result = await query.exec();

    const hasMore = result.length === pagination.limit + 1;
    if (hasMore) result.pop();

    return {
      data: result.map(doc => doc.toJSON()),
      hasMore,
      total,
    };
  }

  async incrementCredits(agentId: string, credits: number): Promise<IAgentDocument | null> {
    return this.agentModel.findByIdAndUpdate(agentId, { $inc: { currentCredits: credits } }, { new: true });
  }

  /**
   * Atomically sets currentCredits to 0 and returns the previous balance.
   * Only matches agents with credits > 0 - concurrent callers get 0 on the second call,
   * preventing double-credit grant on concurrent DELETE requests.
   */
  async claimCredits(agentId: string): Promise<number> {
    const doc = await this.agentModel.findOneAndUpdate(
      { _id: agentId, currentCredits: { $gt: 0 } },
      { $set: { currentCredits: 0 } },
      { new: false } // return pre-update value to know what was claimed
    );
    return doc?.currentCredits ?? 0;
  }

  async awardQuestCompletion(agentId: string, xpGained: number): Promise<IAgentDocument | null> {
    return this.agentModel.findByIdAndUpdate(
      agentId,
      { $inc: { 'tavernStats.xp': xpGained, 'tavernStats.questsCompleted': 1 } },
      { new: true }
    );
  }

  async setTavernLevel(agentId: string, level: number): Promise<void> {
    // $max prevents a stale concurrent write from clobbering a higher level
    await this.agentModel.findByIdAndUpdate(agentId, { $max: { 'tavernStats.level': level } });
  }

  async incrementQuestsPosted(agentId: string): Promise<IAgentDocument | null> {
    return this.agentModel.findByIdAndUpdate(agentId, { $inc: { 'tavernStats.questsPosted': 1 } }, { new: true });
  }

  async appendMemory(agentId: string, entry: IMemoryEntry): Promise<IAgentDocument | null> {
    const agent = await this.agentModel.findById(agentId);
    const maxEntries = agent?.memoryConfig?.maxEntries ?? 50;
    const result = await this.agentModel.findByIdAndUpdate(
      agentId,
      {
        $push: {
          memoryJournal: {
            $each: [entry],
            $slice: -maxEntries,
          },
        },
      },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async getMemoryJournal(agentId: string, limit?: number): Promise<IMemoryEntry[]> {
    const agent = await this.agentModel.findById(agentId).select('memoryJournal').lean();
    if (!agent?.memoryJournal) return [];
    const entries = agent.memoryJournal as IMemoryEntry[];
    return limit ? entries.slice(-limit) : entries;
  }

  /** Wholesale replace the memoryJournal - used by consolidation/grooming.
   *  appendMemory uses $push and won't shrink the array, so a separate
   *  replace path is required. */
  async replaceMemoryJournal(agentId: string, entries: IMemoryEntry[]): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, {
      $set: {
        memoryJournal: entries,
        'memoryConfig.lastConsolidatedAt': new Date(),
      },
    });
  }

  // World memory: capped-array pattern mirroring memoryJournal, retains last 100 entries.
  async appendWorldMemory(agentId: string, entry: IWorldMemoryEntry): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, {
      $push: {
        worldMemory: {
          $each: [entry],
          $slice: -100,
        },
      },
    });
  }

  async getWorldMemory(agentId: string, limit?: number): Promise<IWorldMemoryEntry[]> {
    const agent = await this.agentModel.findById(agentId).select('worldMemory').lean();
    if (!agent?.worldMemory) return [];
    const entries = agent.worldMemory as IWorldMemoryEntry[];
    return limit ? entries.slice(-limit) : entries;
  }

  async findHeartbeatEligible(): Promise<IAgentDocument[]> {
    const now = new Date();
    const result = await this.agentModel.find({
      deletedAt: null,
      'heartbeatConfig.enabled': true,
      $or: [
        { 'heartbeatConfig.lastHeartbeatAt': { $exists: false } },
        {
          $expr: {
            $lt: [
              '$heartbeatConfig.lastHeartbeatAt',
              { $subtract: [now, { $multiply: ['$heartbeatConfig.intervalMinutes', 60000] }] },
            ],
          },
        },
      ],
    });
    return result.map(doc => doc.toJSON());
  }

  async pushPendingMessage(agentId: string, message: IPendingAgentMessage): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, {
      $push: { pendingMessages: message },
    });
  }

  async consumePendingMessages(agentId: string): Promise<IPendingAgentMessage[]> {
    const agent = await this.agentModel.findByIdAndUpdate(agentId, { $set: { pendingMessages: [] } }, { new: false });
    return (agent?.pendingMessages as IPendingAgentMessage[] | undefined) || [];
  }

  async addCooldown(agentId: string, otherAgentId: string, cooldownUntil: Date): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, {
      $push: { conversationCooldowns: { otherAgentId, cooldownUntil } },
    });
  }

  async cleanExpiredCooldowns(agentId: string): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, {
      $pull: { conversationCooldowns: { cooldownUntil: { $lt: new Date() } } },
    });
  }

  async setHeartbeatEnabled(agentId: string, enabled: boolean): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, {
      $set: { 'heartbeatConfig.enabled': enabled },
    });
  }

  async bulkSetHeartbeatEnabled(userId: string, enabled: boolean): Promise<{ modifiedCount: number }> {
    const result = await this.agentModel.updateMany(
      { userId, deletedAt: null },
      { $set: { 'heartbeatConfig.enabled': enabled } }
    );
    return { modifiedCount: result.modifiedCount };
  }

  async updateTavernSessionId(agentId: string, sessionId: string): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, { $set: { tavernSessionId: sessionId } });
  }

  async updateCurrentFloorId(agentId: string, floorId: string): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, { $set: { currentFloorId: floorId } });
  }

  async countByUserId(userId: string): Promise<number> {
    // deletedAt must be `null`, not `$exists: false`: softDeletePlugin defaults
    // the field to null on every document, so `$exists: false` matches nothing.
    // find()/findOne() were shielded (the plugin's pre-hooks overwrite the
    // condition) but countDocuments has no hook, which left this count at 0 for
    // everyone and kept the Agents gear permanently locked.
    return this.agentModel.countDocuments({ userId, deletedAt: null });
  }

  async setHeartbeatStarted(agentId: string): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, {
      $set: { 'heartbeatConfig.heartbeatStartedAt': new Date() },
    });
  }

  async clearHeartbeatStarted(agentId: string): Promise<void> {
    await this.agentModel.findByIdAndUpdate(agentId, {
      $unset: { 'heartbeatConfig.heartbeatStartedAt': '' },
    });
  }

  async updateHeartbeat(agentId: string, timestamp: Date, mood?: { energy: number; curiosity: number }): Promise<void> {
    const update: Record<string, unknown> = {
      'heartbeatConfig.lastHeartbeatAt': timestamp,
    };
    if (mood) {
      update['heartbeatConfig.mood.energy'] = mood.energy;
      update['heartbeatConfig.mood.curiosity'] = mood.curiosity;
      update['heartbeatConfig.mood.updatedAt'] = timestamp;
    }
    await this.agentModel.findByIdAndUpdate(agentId, {
      $set: update,
      $unset: { 'heartbeatConfig.heartbeatStartedAt': '' },
    });
  }

  // Scope-aware lookups. Used by the agent executor's unified
  // ServerAgentStore construction.

  async listForUser(userId: string): Promise<IAgent[]> {
    const results = await this.agentModel.find({ userId, deletedAt: null }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  async listForOrganization(organizationId: string): Promise<IAgent[]> {
    const results = await this.agentModel.find({ organizationId, deletedAt: null }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  async listSystem(): Promise<IAgent[]> {
    const results = await this.agentModel.find({ isSystem: true, deletedAt: null }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  /**
   * Lists every public voice agent (admin-created ElevenLabs-backed agents
   * surfaced to all users on the /agents Voice Agents tab).
   */
  async listPublicVoiceAgents(): Promise<IAgent[]> {
    const results = await this.agentModel.find({ type: 'voice', isPublic: true, deletedAt: null }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  /** Lists every voice agent (used by admin Voice Settings page; includes non-public). */
  async listAllVoiceAgents(): Promise<IAgent[]> {
    const results = await this.agentModel.find({ type: 'voice', deletedAt: null }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  /** Returns the org-wide default voice agent, or null if none is set. */
  async findDefaultVoiceAgent(): Promise<IAgent | null> {
    const result = await this.agentModel.findOne({
      type: 'voice',
      isDefaultVoiceAgent: true,
      deletedAt: null,
    });
    return result?.toJSON() ?? null;
  }

  /**
   * Sets `id` as the sole default voice agent: clears the flag on every other
   * voice agent, then sets it on this one. Enforces the at-most-one invariant.
   */
  async setDefaultVoiceAgent(id: string): Promise<void> {
    await this.agentModel.updateMany({ type: 'voice', _id: { $ne: id } }, { $set: { isDefaultVoiceAgent: false } });
    await this.agentModel.updateOne({ _id: id }, { $set: { isDefaultVoiceAgent: true } });
  }

  async findByNameForUser(userId: string, name: string): Promise<IAgent | null> {
    const result = await this.agentModel.findOne({ userId, name, deletedAt: null });
    return result?.toJSON() ?? null;
  }

  async findByNameForOrganization(organizationId: string, name: string): Promise<IAgent | null> {
    const result = await this.agentModel.findOne({
      organizationId,
      name,
      deletedAt: null,
    });
    return result?.toJSON() ?? null;
  }
}

export const AgentSchema = new Schema<IAgent, IAgentModel, IAgentMethods>(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },

    // Kind discriminator: 'persona' (LLM chat persona, default) or 'voice'
    // (ElevenLabs Conversational AI agent mirrored as a B4M Agent).
    type: { type: String, enum: ['persona', 'voice'], default: 'persona' },
    // External provider for voice agents.
    provider: { type: String, enum: ['elevenlabs'] },
    // ElevenLabs Conversational AI agent ID for voice agents.
    elevenLabsAgentId: { type: String },
    // ElevenLabs TTS voice ID configured on the agent (for edit-form pre-fill).
    elevenLabsVoiceId: { type: String },
    // Spoken greeting the voice agent opens with (for edit-form pre-fill).
    firstMessage: { type: String },
    // Org-wide default voice agent (at most one). Every Voice v2 session routes
    // through it; users layer personal voice/prompt overrides on top.
    isDefaultVoiceAgent: { type: Boolean, default: false },
    // ElevenLabs turn-taking eagerness (for edit-form pre-fill); patient waits
    // longest through pauses, eager responds soonest.
    turnEagerness: { type: String, enum: ['patient', 'normal', 'eager'] },
    // Seconds of user silence before the voice agent re-engages (edit-form pre-fill).
    // Mirrors the admin API's Zod validation (z.number().int().min(1).max(30)) so
    // non-API writes can't persist out-of-range or fractional values (ElevenLabs
    // expects whole seconds). Mongoose has no integer type, so enforce it via a
    // validator alongside the min/max bounds.
    turnTimeoutSeconds: {
      type: Number,
      min: 1,
      max: 30,
      validate: {
        validator: Number.isInteger,
        message: 'turnTimeoutSeconds must be an integer',
      },
    },

    // Scope discriminator. Exactly one of userId / organizationId / isSystem
    // must be set. userId is no longer `required: true` so org-shared and system
    // (built-in) agents can exist without an owning user. Validation enforced
    // by the pre-save hook below.
    userId: { type: String },
    organizationId: { type: String },
    isSystem: { type: Boolean },

    projectId: { type: String },

    triggerWords: [{ type: String, required: true }],
    isPublic: { type: Boolean, required: true, default: false },
    capabilities: [{ type: String, required: true }],

    useOwnCredits: { type: Boolean, required: true, default: false },
    currentCredits: { type: Number },

    // System prompt for agent behavior (generated from personality)
    systemPrompt: { type: String, default: '' },

    // Orchestration fields (folded in from IAgentDefinition).
    // All optional - agent executor applies runtime defaults when absent.
    allowedTools: { type: [String] },
    deniedTools: { type: [String] },
    maxIterations: { type: MaxIterationsSchema },
    defaultThoroughness: { type: String, enum: THOROUGHNESS_LEVELS },
    defaultVariables: {
      type: mongoose.Schema.Types.Mixed,
      validate: {
        validator: (value: unknown): boolean => {
          if (value === undefined || value === null) return true;
          if (typeof value !== 'object' || Array.isArray(value)) return false;
          return Object.values(value as Record<string, unknown>).every(v => typeof v === 'string');
        },
        message: 'defaultVariables must be a flat object of string values',
      },
    },
    exclusiveMcpServers: { type: [String] },
    fallbackModels: { type: [String] },

    // AI model configuration (absent = use system defaults)
    preferredModel: { type: String },
    preferredImageModel: { type: String },
    temperature: { type: Number, min: 0, max: 2 },
    maxTokens: { type: Number, min: 1, max: 200000 },

    // Add personality schema
    personality: {
      // Core personality dimensions
      majorMotivation: { type: String, default: '' },
      minorMotivation: { type: String, default: '' },
      flaw: { type: String, default: '' },
      quirk: { type: String, default: '' },
      description: { type: String, default: '' },

      // Enhanced personality dimensions (optional for backward compatibility)
      emotionalIntelligence: { type: String, default: '' },
      communicationPattern: { type: String, default: '' },
      memoryStyle: { type: String, default: '' },
      culturalFlavor: { type: String, default: '' },
      energyLevel: { type: String, default: '' },
      humorStyle: { type: String, default: '' },
      backstoryElement: { type: String, default: '' },
      problemSolvingApproach: { type: String, default: '' },

      // Agency and purpose dimensions
      personalMission: { type: String, default: '' }, // Their burning life purpose
      activeProject: { type: String, default: '' }, // What they're currently working on
      secretAmbition: { type: String, default: '' }, // Hidden dream they're pursuing
      coreValues: { type: String, default: '' }, // Unshakeable beliefs that guide them
      legacyAspiration: { type: String, default: '' }, // How they want to be remembered
      growthChallenge: { type: String, default: '' }, // Current personal struggle they're working through

      // Meta information for enhanced personalities
      personalityComplexity: {
        type: String,
        enum: ['simple', 'moderate', 'complex', 'maximum'],
        default: 'simple',
      },
      generationTimestamp: { type: String, default: '' },
      uniqueId: { type: String, default: '' },
    },

    // Add visual schema
    visual: {
      portraitUrl: { type: String, default: '' },
      style: { type: String, default: 'modern' },
      generationPrompt: { type: String, default: '' },
    },

    // Add identity schema
    identity: {
      gender: {
        type: String,
        enum: ['male', 'female', 'non-binary', 'agender', 'genderfluid', 'other', 'prefer-not-to-say'],
        default: 'prefer-not-to-say',
      },
      pronouns: {
        subject: { type: String, default: '' },
        object: { type: String, default: '' },
        possessive: { type: String, default: '' },
        possessiveAdjective: { type: String, default: '' },
        reflexive: { type: String, default: '' },
      },
      customPronouns: { type: String, default: '' },
    },

    // Memory Journal - persistent agent memory across sessions
    memoryJournal: [
      {
        id: { type: String, required: true },
        timestamp: { type: Date, required: true },
        source: { type: String, enum: ['conversation', 'heartbeat', 'consolidation', 'manual'], required: true },
        content: { type: String, required: true, maxlength: 500 },
        importance: { type: Number, required: true, min: 1, max: 5 },
        tags: [{ type: String }],
        relatedEntityIds: [{ type: String }],
        expiresAt: { type: Date },
      },
    ],
    memoryConfig: {
      maxEntries: { type: Number, default: 50 },
      summarizeThreshold: { type: Number, default: 40 },
      lastConsolidatedAt: { type: Date },
    },

    // World Memory - agent's building/change history (tavern NLP world-building)
    worldMemory: [
      {
        id: { type: String, required: true },
        timestamp: { type: Date, required: true },
        action: {
          type: String,
          enum: ['placed', 'removed', 'moved', 'built_room', 'cleared'],
          required: true,
        },
        catalogKey: { type: String },
        description: { type: String, required: true, maxlength: 500 },
        floorId: { type: String, required: true, default: 'surface' },
        location: {
          col: { type: Number, required: true },
          row: { type: Number, required: true },
        },
        area: {
          width: { type: Number },
          height: { type: Number },
        },
      },
    ],

    // Heartbeat - agent initiative between prompts
    heartbeatConfig: {
      enabled: { type: Boolean, default: false },
      intervalMinutes: { type: Number, default: 3 },
      lastHeartbeatAt: { type: Date },
      heartbeatStartedAt: { type: Date },
      mood: {
        energy: { type: Number, default: 50, min: 0, max: 100 },
        curiosity: { type: Number, default: 50, min: 0, max: 100 },
        updatedAt: { type: Date },
      },
    },

    // Agent-to-Agent DM - pending messages and cooldowns
    pendingMessages: [
      {
        id: { type: String, required: true },
        fromAgentId: { type: String, required: true },
        fromAgentName: { type: String, required: true },
        text: { type: String, required: true, maxlength: 100 },
        threadId: { type: String, required: true },
        exchangeNumber: { type: Number, required: true },
        createdAt: { type: Date, required: true },
      },
    ],
    conversationCooldowns: [
      {
        otherAgentId: { type: String, required: true },
        cooldownUntil: { type: Date, required: true },
      },
    ],

    // Tavern Session - persistent B4M session for agent notebook
    tavernSessionId: { type: String },

    // Floor the agent is currently on (persisted across heartbeats)
    currentFloorId: { type: String, default: 'surface' },

    // Tavern Stats - XP/reputation tracking
    tavernStats: {
      xp: { type: Number, default: 0 },
      questsCompleted: { type: Number, default: 0 },
      questsPosted: { type: Number, default: 0 },
      reputation: { type: Number, default: 3.0 },
      level: { type: Number, default: 1 },
    },

    ...ShareableDocumentSchema,
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    virtuals: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

AgentSchema.plugin(softDeletePlugin);

// Scope discriminator validation. Exactly one of userId, organizationId,
// or isSystem must be set. Enforced at the model layer because Mongoose doesn't
// have a native "exactly one of" constraint.
AgentSchema.pre('validate', function (next) {
  const scopes = [Boolean(this.userId), Boolean(this.organizationId), Boolean(this.isSystem)];
  const setCount = scopes.filter(Boolean).length;
  if (setCount !== 1) {
    next(new Error('IAgent must have exactly one of: userId, organizationId, isSystem'));
    return;
  }

  // Normalize trigger words to lowercase so the case-insensitive
  // detectAgentMentions() extraction always matches stored values.
  if (this.isModified('triggerWords') && Array.isArray(this.triggerWords)) {
    this.triggerWords = this.triggerWords.map((tw: string) => tw.toLowerCase());
  }

  next();
});

AgentSchema.index({ 'heartbeatConfig.enabled': 1, 'heartbeatConfig.lastHeartbeatAt': 1 });
// findByTriggerWords - chat-path mention routing; multikey on triggerWords array
AgentSchema.index({ triggerWords: 1, userId: 1, deletedAt: 1 });
// Index for countByUserId - runs on every agent creation to enforce per-tier limits
AgentSchema.index({ userId: 1, deletedAt: 1 });
// Org-scoped agent lookup
AgentSchema.index({ organizationId: 1, deletedAt: 1 });
// Name lookup within a scope - supports findByNameForUser / findByNameForOrganization
AgentSchema.index({ name: 1, userId: 1 });
AgentSchema.index({ name: 1, organizationId: 1 });

export const Agent: IAgentModel =
  (mongoose.models[ModelName] as unknown as IAgentModel) ?? model<IAgent, IAgentModel>(ModelName, AgentSchema);

export const agentRepository = new AgentRepository(Agent, {
  shareable: new ShareableDocumentRepository(Agent),
});

export default Agent;
