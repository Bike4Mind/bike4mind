/**
 * Type Definitions for Thread Intelligence
 */

/**
 * Slack message metadata for app-to-app communication
 */
export interface SlackMetadata {
  event_type: string;
  event_payload: Record<string, unknown>;
}

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  files?: Array<{
    name: string;
    mimetype: string;
    url_private: string;
    title?: string;
  }>;
  metadata?: SlackMetadata; // Hidden metadata for app-to-app communication
}

export interface ThreadSummary {
  mainTopics: string[];
  keyPoints: string[];
  participantCount: number;
  messageCount: number;
  timeSpan: string;
}

export interface Decision {
  decision: string;
  madeBy: string[];
  timestamp: string;
}

export interface ActionItem {
  task: string;
  assignee?: string;
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  extractedFrom: string;
}

export interface Participant {
  userId: string;
  name: string;
  messageCount: number;
  contributions: string[];
}

export interface Attachment {
  type: string;
  url: string;
  title: string;
}

export interface ThreadIntelligence {
  summary: ThreadSummary;
  decisions: Decision[];
  actionItems: ActionItem[];
  participants: Participant[];
  attachments: Attachment[];
  sentiment: {
    overall: 'positive' | 'neutral' | 'negative' | 'mixed';
    conflictDetected: boolean;
  };
}
