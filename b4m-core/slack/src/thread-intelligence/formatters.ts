/**
 * Formatters for Thread Intelligence Output
 */

import { ThreadIntelligence, SlackMessage } from './types';

/**
 * Calculates time span of conversation
 */
export function calculateTimeSpan(messages: SlackMessage[]): string {
  if (messages.length === 0) return '0 seconds';

  const timestamps = messages.map(m => parseFloat(m.ts));
  const earliest = Math.min(...timestamps);
  const latest = Math.max(...timestamps);
  const diffSeconds = latest - earliest;

  if (diffSeconds < 60) return `${Math.round(diffSeconds)} seconds`;
  if (diffSeconds < 3600) return `${Math.round(diffSeconds / 60)} minutes`;
  if (diffSeconds < 86400) return `${Math.round(diffSeconds / 3600)} hours`;
  return `${Math.round(diffSeconds / 86400)} days`;
}

/**
 * Formats thread intelligence into a human-readable summary
 */
export function formatThreadIntelligence(intelligence: ThreadIntelligence): string {
  const parts: string[] = [];

  // Summary
  parts.push('📊 *Thread Summary*');
  parts.push(`• Duration: ${intelligence.summary.timeSpan}`);
  parts.push(`• Participants: ${intelligence.summary.participantCount}`);
  parts.push(`• Messages: ${intelligence.summary.messageCount}`);
  parts.push(`• Topics: ${intelligence.summary.mainTopics.join(', ')}`);
  parts.push('');

  // Key Points
  if (intelligence.summary.keyPoints.length > 0) {
    parts.push('🔑 *Key Points*');
    intelligence.summary.keyPoints.forEach(point => {
      parts.push(`• ${point}`);
    });
    parts.push('');
  }

  // Participants with contributions
  if (intelligence.participants.length > 0) {
    parts.push('👥 *Key Participants*');
    intelligence.participants.forEach(participant => {
      const contributions =
        participant.contributions.length > 0 ? ` - ${participant.contributions[0].slice(0, 50)}...` : '';
      parts.push(`• ${participant.name} (${participant.messageCount} messages)${contributions}`);
    });
    parts.push('');
  }

  // Decisions
  if (intelligence.decisions.length > 0) {
    parts.push('✅ *Decisions Made*');
    intelligence.decisions.forEach(decision => {
      parts.push(`• ${decision.decision.slice(0, 100)}`);
    });
    parts.push('');
  }

  // Action Items
  if (intelligence.actionItems.length > 0) {
    parts.push('📋 *Action Items*');
    intelligence.actionItems.forEach(item => {
      const assignee = item.assignee ? ` (assigned to ${item.assignee})` : '';
      const priority = item.priority ? ` [${item.priority}]` : '';
      parts.push(`• ${item.task}${assignee}${priority}`);
    });
    parts.push('');
  }

  // Attachments
  if (intelligence.attachments.length > 0) {
    parts.push('📎 *Attachments*');
    intelligence.attachments.forEach(attachment => {
      const icon = attachment.type === 'image' ? '🖼️' : '📄';
      parts.push(`• ${icon} ${attachment.title}`);
    });
    parts.push('');
  }

  // Sentiment
  parts.push(`💭 *Sentiment*: ${intelligence.sentiment.overall}`);
  if (intelligence.sentiment.conflictDetected) {
    parts.push('⚠️ Potential areas of disagreement detected');
  }

  return parts.join('\n');
}
