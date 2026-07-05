/**
 * Analyzers for Sentiment and Participants
 */

import { SlackMessage, Participant } from './types';
import { CONCERN_PATTERNS, QUESTION_PATTERNS, DECISION_PATTERNS, ACTION_PATTERNS } from './patterns';

// Sentiment Analysis

/**
 * Analyzes overall sentiment of the conversation
 */
export function analyzeSentiment(messages: SlackMessage[]): {
  overall: 'positive' | 'neutral' | 'negative' | 'mixed';
  conflictDetected: boolean;
} {
  const positiveWords = [
    'great',
    'good',
    'yes',
    'agree',
    'perfect',
    'awesome',
    'nice',
    'thanks',
    'love',
    'excellent',
    'works',
    'success',
    'correct',
  ];
  const negativeWords = [
    'bad',
    'wrong',
    'terrible',
    'awful',
    'broken',
    'fail',
    'failed',
    'error',
    'disappointed',
    'frustrated',
  ];

  let positiveCount = 0;
  let negativeCount = 0;

  messages.forEach(msg => {
    const lowerText = msg.text.toLowerCase();
    positiveWords.forEach(word => {
      if (lowerText.includes(word)) positiveCount++;
    });
    negativeWords.forEach(word => {
      if (lowerText.includes(word)) negativeCount++;
    });
  });

  // Detect conflict (questions + concerns)
  const conflictCount = messages.filter(msg => {
    return QUESTION_PATTERNS.some(p => p.test(msg.text)) || CONCERN_PATTERNS.some(p => p.test(msg.text));
  }).length;

  const conflictDetected = conflictCount > messages.length * 0.3;

  // Determine overall sentiment
  let overall: 'positive' | 'neutral' | 'negative' | 'mixed' = 'neutral';
  if (positiveCount > negativeCount * 1.5) {
    overall = 'positive';
  } else if (negativeCount > positiveCount * 1.5) {
    overall = 'negative';
  } else if (positiveCount > 0 && negativeCount > 0) {
    overall = 'mixed';
  }

  return {
    overall,
    conflictDetected,
  };
}

// Participant Analysis

/**
 * Analyzes participants and extracts their key contributions
 */
export function analyzeParticipants(messages: SlackMessage[]): Participant[] {
  const participantMap = new Map<string, Participant>();

  // Count messages per participant
  messages.forEach(msg => {
    if (!participantMap.has(msg.user)) {
      participantMap.set(msg.user, {
        userId: msg.user,
        name: msg.user, // In real Slack, this would be fetched from user API
        messageCount: 0,
        contributions: [],
      });
    }

    const participant = participantMap.get(msg.user)!;
    participant.messageCount++;

    // Extract key contributions (decisions, action items, important messages)
    const isDecision = DECISION_PATTERNS.some(pattern => pattern.test(msg.text));
    const isAction = ACTION_PATTERNS.some(pattern => pattern.test(msg.text));
    const isLongMessage = msg.text.length > 100; // Longer messages often contain more substance

    if (isDecision || isAction || isLongMessage) {
      // Add this as a contribution (limit to first 100 chars)
      const contribution = msg.text.slice(0, 100);
      if (participant.contributions.length < 3) {
        // Keep top 3 contributions per person
        participant.contributions.push(contribution);
      }
    }
  });

  // Convert to array and sort by message count (most active first)
  const participants = Array.from(participantMap.values());
  participants.sort((a, b) => b.messageCount - a.messageCount);

  return participants;
}
