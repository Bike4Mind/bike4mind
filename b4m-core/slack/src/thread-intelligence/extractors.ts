/**
 * Extractors for Topics, Decisions, Action Items, and Attachments
 */

import { SlackMessage, Decision, ActionItem, Attachment } from './types';
import { DECISION_PATTERNS, ACTION_PATTERNS, PRIORITY_PATTERN, STOPWORDS } from './patterns';

// Topic Extraction

/**
 * Extracts main topics from messages using keyword frequency analysis
 */
export function extractTopics(messages: SlackMessage[]): string[] {
  const allText = messages.map(m => m.text).join(' ');

  // Extract words and count frequency
  const words = allText
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !STOPWORDS.has(word));

  const frequency = new Map<string, number>();
  words.forEach(word => {
    frequency.set(word, (frequency.get(word) || 0) + 1);
  });

  // Get top topics by frequency
  const sortedTopics = Array.from(frequency.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  return sortedTopics;
}

/**
 * Extracts key points using basic pattern matching
 */
export function extractKeyPointsBasic(messages: SlackMessage[]): string[] {
  const points: string[] = [];

  // Look for messages with decisions
  messages.forEach(msg => {
    if (DECISION_PATTERNS.some(pattern => pattern.test(msg.text))) {
      points.push(msg.text.slice(0, 100)); // First 100 chars
    }
  });

  // Look for messages with action items
  messages.forEach(msg => {
    if (ACTION_PATTERNS.some(pattern => pattern.test(msg.text))) {
      points.push(msg.text.slice(0, 100));
    }
  });

  return points.slice(0, 5);
}

// Decision Detection

/**
 * Detects decision points in the conversation
 */
export function detectDecisions(messages: SlackMessage[]): Decision[] {
  const decisions: Decision[] = [];

  messages.forEach(msg => {
    // Check if message contains decision language
    const matchedPattern = DECISION_PATTERNS.find(pattern => pattern.test(msg.text));
    if (matchedPattern) {
      decisions.push({
        decision: msg.text,
        madeBy: [msg.user],
        timestamp: msg.ts,
      });
    }
  });

  // Look for agreement patterns (when multiple people agree)
  const agreementDecisions = detectAgreements(messages);
  decisions.push(...agreementDecisions);

  return decisions;
}

/**
 * Detects when multiple participants agree on something
 */
function detectAgreements(messages: SlackMessage[]): Decision[] {
  const decisions: Decision[] = [];
  const agreementWords = ['agree', 'agreed', 'yes', 'yeah', 'sounds good', '+1'];

  for (let i = 1; i < messages.length; i++) {
    const currentMsg = messages[i];
    const previousMsg = messages[i - 1];

    // Check if current message is an agreement (text-based only)
    const isAgreement = agreementWords.some(word => currentMsg.text.toLowerCase().includes(word));

    if (isAgreement && previousMsg.text.length > 20) {
      decisions.push({
        decision: previousMsg.text,
        madeBy: [previousMsg.user, currentMsg.user],
        timestamp: currentMsg.ts,
      });
    }
  }

  return decisions;
}

// Action Item Extraction

/**
 * Extracts action items from messages
 */
export function extractActionItems(messages: SlackMessage[]): ActionItem[] {
  const actionItems: ActionItem[] = [];

  messages.forEach(msg => {
    // Skip questions (messages ending with ? or starting with question words)
    const isQuestion = msg.text.trim().endsWith('?') || /^(what|how|why|when|where|who)\b/i.test(msg.text.trim());
    if (isQuestion) return;

    // Check for action patterns
    ACTION_PATTERNS.forEach(pattern => {
      const match = msg.text.match(pattern);
      if (match) {
        const task = match[1] || msg.text;

        // Try to extract assignee
        const assigneeMatch = msg.text.match(/assign(?:ed)? to (\w+)/i) || msg.text.match(/(\w+) will/i);
        const assignee = assigneeMatch ? assigneeMatch[1] : undefined;

        // Try to extract priority
        const priorityMatch = msg.text.match(PRIORITY_PATTERN);
        const priority = priorityMatch ? (`P${priorityMatch[1]}` as 'P0' | 'P1' | 'P2' | 'P3') : undefined;

        actionItems.push({
          task: task.trim(),
          assignee,
          priority,
          extractedFrom: msg.text,
        });
      }
    });
  });

  // Remove duplicates
  const uniqueActions = actionItems.filter((item, index, self) => index === self.findIndex(t => t.task === item.task));

  return uniqueActions;
}

// Attachment Extraction

/**
 * Extracts attachments (files, images) from messages
 */
export function extractAttachments(messages: SlackMessage[]): Attachment[] {
  const attachments: Attachment[] = [];

  messages.forEach(msg => {
    // Extract files from Slack message files array
    if (msg.files && msg.files.length > 0) {
      msg.files.forEach(file => {
        attachments.push({
          type: file.mimetype?.startsWith('image/') ? 'image' : 'file',
          url: file.url_private || '',
          title: file.title || file.name || 'Untitled',
        });
      });
    }
  });

  return attachments;
}
