// b4m-core/common/src/types/entities/AgentTypes.ts
import { IBaseRepository } from './BaseTypes';
import { ICreditHolder, ICreditHolderMethods } from './CreditHolderTypes';
import { IModelConfig } from './ModelConfigTypes';
import { IShareableDocument, IShareableStaticMethods } from './ShareableDocumentTypes';

export interface IAgentMethods {
  // Add instance methods here...
}

export interface IAgentRepository extends IBaseRepository<IAgentDocument>, ICreditHolderMethods {
  shareable: IShareableStaticMethods<IAgentDocument>;

  /**
   * Find an agent by ID and user ID
   *
   * @param id - The agent ID
   * @param userId - The user ID
   * @returns The agent
   */
  findByIdAndUserId: (id: string, userId: string) => Promise<IAgentDocument | null>;

  /**
   * Find agents by trigger words
   *
   * @param triggerWords - Array of words that might trigger an agent
   * @param userId - The user ID (agents can be user-specific)
   * @returns The matching agents
   */
  findByTriggerWords: (triggerWords: string[], userId: string) => Promise<IAgentDocument[]>;

  /**
   * Search for accessible agents
   *
   * @param userId - The user ID
   * @param search - The search query
   * @param filters - The filters
   * @param pagination - The pagination
   * @param orderBy - The order by
   * @returns The agents
   */
  searchAccessible: (
    userId: string,
    search: string,
    filters: { isPublic?: boolean; query?: Record<string, unknown> },
    pagination: { page: number; limit: number },
    orderBy: { by: 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' }
  ) => Promise<{ data: IAgent[]; hasMore: boolean; total: number }>;

  appendMemory: (agentId: string, entry: IMemoryEntry) => Promise<IAgentDocument | null>;
  getMemoryJournal: (agentId: string, limit?: number) => Promise<IMemoryEntry[]>;
  replaceMemoryJournal: (agentId: string, entries: IMemoryEntry[]) => Promise<void>;
  appendWorldMemory: (agentId: string, entry: IWorldMemoryEntry) => Promise<void>;
  getWorldMemory: (agentId: string, limit?: number) => Promise<IWorldMemoryEntry[]>;
  findHeartbeatEligible: () => Promise<IAgentDocument[]>;
  updateHeartbeat: (agentId: string, timestamp: Date, mood?: { energy: number; curiosity: number }) => Promise<void>;
  pushPendingMessage(agentId: string, message: IPendingAgentMessage): Promise<void>;
  consumePendingMessages(agentId: string): Promise<IPendingAgentMessage[]>;
  addCooldown(agentId: string, otherAgentId: string, cooldownUntil: Date): Promise<void>;
  cleanExpiredCooldowns(agentId: string): Promise<void>;
  bulkSetHeartbeatEnabled(userId: string, enabled: boolean): Promise<{ modifiedCount: number }>;
  awardQuestCompletion(agentId: string, xpGained: number): Promise<IAgentDocument | null>;
  setTavernLevel(agentId: string, level: number): Promise<void>;
  incrementQuestsPosted(agentId: string): Promise<IAgentDocument | null>;
  updateCurrentFloorId(agentId: string, floorId: string): Promise<void>;
  countByUserId(userId: string): Promise<number>;

  // Scope-aware lookups used by ServerAgentStore construction in the agent
  // executor. Each list returns non-soft-deleted records only.
  listForUser(userId: string): Promise<IAgent[]>;
  listForOrganization(organizationId: string): Promise<IAgent[]>;
  listSystem(): Promise<IAgent[]>;
  findByNameForUser(userId: string, name: string): Promise<IAgent | null>;
  findByNameForOrganization(organizationId: string, name: string): Promise<IAgent | null>;
}

export type MemorySource = 'conversation' | 'heartbeat' | 'consolidation' | 'manual';

export interface IMemoryEntry {
  id: string;
  timestamp: Date;
  source: MemorySource;
  content: string;
  importance: number; // 1-5
  tags?: string[];
  relatedEntityIds?: string[];
  expiresAt?: Date;
}

/** Types of world-building actions recorded in an agent's world memory. */
export type WorldMemoryAction = 'placed' | 'removed' | 'moved' | 'built_room' | 'cleared';

/** An entry recording something the agent built or changed in the tavern world.
 *  Injected into the agent's system prompt so it can remember prior builds. */
export interface IWorldMemoryEntry {
  id: string;
  timestamp: Date;
  action: WorldMemoryAction;
  /** Catalog key of the item involved (when applicable) */
  catalogKey?: string;
  /** Human-readable description ("Built 'Library' (10x8) with wood floor, south doorway") */
  description: string;
  /** Floor identifier (future-proofing for multi-floor worlds; default "surface") */
  floorId: string;
  /** Absolute tile coordinates where the action occurred */
  location: { col: number; row: number };
  /** Rectangular area dimensions (for build_room / clear_area / placed stamps) */
  area?: { width: number; height: number };
}

export interface IPendingAgentMessage {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  text: string;
  threadId: string;
  exchangeNumber: number;
  createdAt: Date;
}

export interface IConversationCooldown {
  otherAgentId: string;
  cooldownUntil: Date;
}

export interface IMemoryConfig {
  maxEntries: number;
  summarizeThreshold: number;
  lastConsolidatedAt?: Date;
}

export interface IHeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  lastHeartbeatAt?: Date;
  /** Set when a heartbeat begins processing, cleared on completion/error */
  heartbeatStartedAt?: Date | null;
  mood?: {
    energy: number; // 0-100
    curiosity: number; // 0-100
    updatedAt: Date;
  };
}

export interface ITavernStats {
  xp: number;
  questsCompleted: number;
  questsPosted: number;
  reputation: number; // 1-5 scale
  level: number;
}

/**
 * Kind discriminator for an Agent.
 * - `persona` (default): LLM chat persona - system prompt + personality + tools.
 * - `voice`: ElevenLabs Conversational AI agent. The agent is mirrored as a B4M
 *   `Agent` document so it surfaces on /agents alongside personas, but the
 *   actual runtime is the ElevenLabs agent identified by `elevenLabsAgentId`.
 */
export type AgentKind = 'persona' | 'voice';

/** External provider for voice agents. Only `elevenlabs` for now. */
export type AgentProvider = 'elevenlabs';

export interface IAgent extends ICreditHolder, IModelConfig {
  id: string;
  name: string;
  description: string;

  /**
   * Agent kind. Defaults to `persona` if missing (back-compat for documents
   * created before the field existed).
   */
  type?: AgentKind;

  /**
   * External provider for `type: 'voice'` agents. Required when `type` is
   * `voice`, otherwise omitted.
   */
  provider?: AgentProvider;

  /**
   * ElevenLabs Conversational AI agent ID for `type: 'voice'` agents. Created
   * via the admin Voice Settings page; the B4M Agent is the user-facing
   * surface, this points to the actual ElevenLabs agent runtime.
   */
  elevenLabsAgentId?: string;

  /**
   * ElevenLabs TTS voice ID currently configured on the agent. Stored so the
   * admin edit form can pre-select the current voice; the source of truth is
   * still the ElevenLabs agent.
   */
  elevenLabsVoiceId?: string;

  /**
   * Spoken greeting the voice agent opens the conversation with. Stored so the
   * admin edit form can pre-fill it; the source of truth is the ElevenLabs
   * agent's `first_message`.
   */
  firstMessage?: string;

  /**
   * Marks this voice agent as the org-wide default. At most one voice agent
   * has this set. Every Voice v2 session routes through the default agent;
   * users layer personal voice/prompt overrides on top of it.
   */
  isDefaultVoiceAgent?: boolean;

  /**
   * ElevenLabs turn-taking eagerness (`conversation_config.turn.turn_eagerness`):
   * how readily a pause ends the user's turn. `patient` waits longest (best for
   * users who pause mid-sentence), `eager` responds soonest. Stored so the admin
   * edit form can pre-select it; the source of truth is the ElevenLabs agent.
   */
  turnEagerness?: 'patient' | 'normal' | 'eager';

  /**
   * Seconds of user silence before the voice agent re-engages
   * (`conversation_config.turn.turn_timeout`). Stored for the admin edit form;
   * the source of truth is the ElevenLabs agent.
   */
  turnTimeoutSeconds?: number;

  // Scope discriminator - exactly one must be set: user-owned (chat persona /
  // personal subagent), organization-shared (team-canonical subagent), or
  // built-in/system.
  userId?: string;
  organizationId?: string;
  isSystem?: boolean;

  projectId?: string; // Reference to the Project that powers this agent (optional for project-independent agents)

  // Agent-specific properties
  triggerWords: string[]; // Words like "@help" that activate this agent
  isPublic: boolean; // Whether this agent is available to all users

  // Credit management
  useOwnCredits: boolean; // Use agent's credits vs user's credits

  // System prompt for agent behavior
  systemPrompt?: string; // Generated system prompt for LLM interactions

  // Orchestration fields (folded in from IAgentDefinition). All optional -
  // agent executor applies runtime defaults when absent.
  allowedTools?: string[];
  deniedTools?: string[];
  maxIterations?: { quick: number; medium: number; very_thorough: number };
  defaultThoroughness?: 'quick' | 'medium' | 'very_thorough';
  defaultVariables?: Record<string, string>;
  exclusiveMcpServers?: string[];
  fallbackModels?: string[];

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;

  personality: {
    // Core personality dimensions
    majorMotivation: string;
    minorMotivation: string;
    flaw: string;
    quirk: string;
    description: string;

    // Enhanced personality dimensions
    emotionalIntelligence?: string;
    communicationPattern?: string;
    memoryStyle?: string;
    culturalFlavor?: string;
    energyLevel?: string;
    humorStyle?: string;
    backstoryElement?: string;
    problemSolvingApproach?: string;

    // Agency and purpose dimensions
    personalMission?: string; // Their burning life purpose
    activeProject?: string; // What they're currently working on
    secretAmbition?: string; // Hidden dream they're pursuing
    coreValues?: string; // Unshakeable beliefs that guide them
    legacyAspiration?: string; // How they want to be remembered
    growthChallenge?: string; // Current personal struggle they're working through

    // Meta information for enhanced personalities
    personalityComplexity?: 'simple' | 'moderate' | 'complex' | 'maximum';
    generationTimestamp?: string;
    uniqueId?: string;
  };
  visual: {
    portraitUrl: string;
    style: string;
    generationPrompt: string;
  };
  identity: {
    gender: 'male' | 'female' | 'non-binary' | 'agender' | 'genderfluid' | 'other' | 'prefer-not-to-say';
    pronouns: {
      subject: string; // they, he, she, xe, etc.
      object: string; // them, him, her, xem, etc.
      possessive: string; // their, his, her, xir, etc.
      possessiveAdjective: string; // theirs, his, hers, xirs, etc.
      reflexive: string; // themselves, himself, herself, xemself, etc.
    };
    customPronouns?: string; // Free text for custom pronouns like "ze/zir/zirs"
  };
  capabilities: string[];

  memoryJournal?: IMemoryEntry[];
  memoryConfig?: IMemoryConfig;
  /** World-building history - persistent record of things the agent built/changed. */
  worldMemory?: IWorldMemoryEntry[];
  heartbeatConfig?: IHeartbeatConfig;
  tavernStats?: ITavernStats;
  pendingMessages?: IPendingAgentMessage[];
  conversationCooldowns?: IConversationCooldown[];

  /** B4M session ID for this agent's persistent notebook in the tavern */
  tavernSessionId?: string;

  /** Floor the agent is currently on. Persisted across heartbeats. Default 'surface'. */
  currentFloorId?: string;
}

// Define the ResponseStyle enum
export type ResponseStyle = 'formal' | 'casual' | 'technical' | 'friendly' | 'playful' | 'concise' | 'detailed';

export interface IAgentDocument extends IAgent, IShareableDocument {}

// Helper interface for capabilities data structure (for typing before stringifying)
export interface IAgentCapabilities {
  triggerWords: string[];
  responseStyle: ResponseStyle;
  specialBehaviors: string[];
}

// ---------------------------------------------------------------------------
// Tavern Quest Board
// ---------------------------------------------------------------------------

export type TavernQuestStatus = 'open' | 'claimed' | 'completed' | 'expired';

export interface ITavernQuest {
  id: string;
  title: string;
  description: string;
  postedByAgentId: string;
  postedByAgentName: string;
  claimedByAgentId?: string;
  claimedByAgentName?: string;
  status: TavernQuestStatus;
  reward?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  userId: string; // owner of the tavern instance
  createdAt: Date;
  claimedAt?: Date;
  completedAt?: Date;
  completionNote?: string;
}

export interface ITavernQuestDocument extends ITavernQuest {
  _id: string;
}
