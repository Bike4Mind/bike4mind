import { IBaseRepository } from './BaseTypes';

export interface ISessionAgentConfigProactiveMessaging {
  /**
   * Whether proactive messaging is enabled for this agent-session pair
   */
  enabled: boolean;

  /**
   * Active hours when the agent should attempt to send proactive messages
   */
  activeHours: {
    /**
     * Start hour in 24-hour format (0-23)
     */
    startHour: number;
    /**
     * End hour in 24-hour format (0-23)
     * Note: If endHour < startHour, it's treated as overnight (e.g., 22-6 means 10pm to 6am)
     */
    endHour: number;
    /**
     * User's timezone (e.g., "America/New_York", "Europe/London")
     * If not provided, defaults to UTC
     */
    timezone?: string;
  };

  /**
   * Custom system prompt for proactive messages
   * This is combined with the agent's base system prompt
   */
  systemPrompt?: string;

  /**
   * Minimum hours between proactive messages (default: 24)
   * Prevents spam by ensuring messages aren't sent too frequently
   */
  minIntervalHours?: number;

  /**
   * Timestamp of the last proactive message sent
   * Used to enforce minIntervalHours
   */
  lastProactiveMessageAt?: Date;
}

export interface ISessionAgentConfig {
  /**
   * The unique identifier for the config
   */
  id: string;

  /**
   * The session ID this config belongs to
   */
  sessionId: string;

  /**
   * The agent ID this config belongs to
   */
  agentId: string;

  /**
   * The user ID who owns this config (for authorization)
   */
  userId: string;

  /**
   * Proactive messaging configuration
   */
  proactiveMessaging: ISessionAgentConfigProactiveMessaging;

  /**
   * When this config was created
   */
  createdAt: Date;

  /**
   * When this config was last updated
   */
  updatedAt: Date;
}

export interface ISessionAgentConfigDocument extends ISessionAgentConfig {}

export interface ISessionAgentConfigRepository extends IBaseRepository<ISessionAgentConfigDocument> {
  /**
   * Find config by session ID and agent ID
   */
  findBySessionAndAgent: (sessionId: string, agentId: string) => Promise<ISessionAgentConfigDocument | null>;

  /**
   * Find all configs for a session
   */
  findBySessionId: (sessionId: string) => Promise<ISessionAgentConfigDocument[]>;

  /**
   * Find all configs with proactive messaging enabled
   * Used by the cron job to find agents that should send messages
   */
  findAllWithProactiveMessagingEnabled: () => Promise<ISessionAgentConfigDocument[]>;

  /**
   * Update last proactive message timestamp
   */
  updateLastProactiveMessageAt: (
    sessionId: string,
    agentId: string,
    timestamp: Date
  ) => Promise<ISessionAgentConfigDocument | null>;

  /**
   * Delete configs for a session (when session is deleted)
   */
  deleteBySessionId: (sessionId: string) => Promise<void>;

  /**
   * Delete configs for an agent (when agent is detached from session)
   */
  deleteBySessionAndAgent: (sessionId: string, agentId: string) => Promise<void>;
}
