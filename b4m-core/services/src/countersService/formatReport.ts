import { Logger } from '@bike4mind/observability';
import { KpiMetrics, UserActivityMetrics } from './types';
import {
  AuthEvents,
  LLMEvents,
  SessionEvents,
  FileEvents,
  ApiKeyEvents,
  ElabsEvents,
  FeedbackEvents,
  InviteEvents,
  ModalEvents,
  InboxEvents,
  RegInviteEvents,
  MiscEvents,
  UiNavigationEvents,
  AiEvents,
  AppFileEvents,
  ProjectEvents,
  ProfileEvents,
  FriendshipEvents,
  type CompletionSource,
} from '@bike4mind/common';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { WeeklyReportData } from './types';

dayjs.extend(utc);
dayjs.extend(timezone);

// Event Group Definitions
interface EventGroup {
  name: string;
  emoji: string;
  events: Array<{
    name: string;
    emoji: string;
  }>;
}

const EVENT_GROUPS: EventGroup[] = [
  {
    name: 'User Account Activity',
    emoji: '🔐',
    events: [
      { name: AuthEvents.REGISTER, emoji: '✍️' },
      { name: AuthEvents.RESET_PASSWORD, emoji: '🔒' },
      { name: AuthEvents.RESET_LAND_PASSWORD, emoji: '🔓' },
      { name: AuthEvents.RESET_PASSWORD_TOKEN_EXPIRED, emoji: '⌛' },
      { name: ApiKeyEvents.CREATE_API_KEY, emoji: '🔐' },
      { name: ApiKeyEvents.DELETE_API_KEY, emoji: '🗑️' },
      { name: ApiKeyEvents.SET_API_KEY, emoji: '🔑' },
    ],
  },
  {
    name: 'Session & File Operations',
    emoji: '📁',
    events: [
      { name: SessionEvents.CREATE_SESSION, emoji: '🆕' },
      { name: SessionEvents.UPDATE_SESSION, emoji: '🔄' },
      { name: SessionEvents.DELETE_SESSION, emoji: '❌' },
      { name: SessionEvents.DELETE_ALL_SESSIONS, emoji: '🗑️' },
      { name: SessionEvents.CLONE_SESSION, emoji: '📓' },
      { name: FileEvents.CREATE_FILE, emoji: '📝' },
      { name: FileEvents.UPDATE_FILE, emoji: '✏️' },
      { name: FileEvents.DELETE_FILE, emoji: '🗑️' },
      { name: FileEvents.DELETE_ALL_FILES, emoji: '🗑️' },
      { name: FileEvents.CREATE_FILE_URL, emoji: '🔗' },
      { name: FileEvents.FILE_UPLOADED, emoji: '⬆️' },
      { name: FileEvents.FILE_DOWNLOADED, emoji: '⬇️' },
      { name: FileEvents.GENERATE_FILE_PRESIGNED_URL, emoji: '🔗' },
      { name: AppFileEvents.CREATE_APP_FILE, emoji: '📄' },
      { name: AppFileEvents.DELETE_APP_FILE, emoji: '🗑️' },
      { name: AppFileEvents.UPDATE_APP_FILE_TAGS, emoji: '🏷️' },
    ],
  },
  {
    name: 'AI & Model Activity',
    emoji: '🤖',
    events: [
      { name: LLMEvents.QUEUE_HANDLER_START_MODEL, emoji: '🚀' },
      { name: LLMEvents.QUEUE_HANDLER_START_HEARD_PROMPT, emoji: '👂' },
      { name: LLMEvents.QUEUE_HANDLER_START_AUTO_NAMED_SESSION, emoji: '🏷️' },
      { name: LLMEvents.QUEUE_HANDLER_IMAGE_GENERATE, emoji: '🖼️' },
      { name: AiEvents.AI_GENERATE_IMAGE, emoji: '🎨' },
      { name: AiEvents.NOTEBOOK_SUMMARIZATION, emoji: '📓' },
      { name: ElabsEvents.CREATE_ELABS_VOICE, emoji: '🎤' },
      { name: ElabsEvents.DELETE_ELABS_VOICE, emoji: '🔇' },
      { name: ElabsEvents.SET_ACTIVE_ELABS_VOICE, emoji: '🔊' },
    ],
  },
  {
    name: 'Project Management',
    emoji: '📊',
    events: [
      { name: ProjectEvents.CREATE_PROJECT, emoji: '🆕' },
      { name: ProjectEvents.UPDATE_PROJECT, emoji: '✏️' },
      { name: ProjectEvents.DELETE_PROJECT, emoji: '🗑️' },
      { name: ProjectEvents.VIEW_PROJECT, emoji: '👀' },
      { name: ProjectEvents.ADD_SESSION, emoji: '➕' },
      { name: ProjectEvents.REMOVE_SESSION, emoji: '➖' },
      { name: ProjectEvents.ADD_FILE, emoji: '📎' },
      { name: ProjectEvents.REMOVE_FILE, emoji: '🔗' },
      { name: ProjectEvents.ADD_SYSTEM_PROMPT, emoji: '💬' },
      { name: ProjectEvents.REMOVE_SYSTEM_PROMPT, emoji: '🗑️' },
      { name: ProjectEvents.ADD_MEMBER, emoji: '👥' },
      { name: ProjectEvents.REMOVE_MEMBER, emoji: '👤' },
      { name: ProjectEvents.UPDATE_MEMBER_ROLE, emoji: '🔄' },
      { name: ProjectEvents.ADD_GROUP, emoji: '👥' },
      { name: ProjectEvents.REMOVE_GROUP, emoji: '🚫' },
      { name: ProjectEvents.UPDATE_GROUP_ROLE, emoji: '🔄' },
      { name: ProjectEvents.PROJECT_JOINED, emoji: '🤝' },
      { name: ProjectEvents.PROJECT_LEAVED, emoji: '👋' },
      { name: ProjectEvents.UPDATE_SHARING, emoji: '🔐' },
    ],
  },
  {
    name: 'Profile & Friendship',
    emoji: '👥',
    events: [
      { name: ProfileEvents.PROFILE_VIEW, emoji: '👀' },
      { name: FriendshipEvents.FRIENDSHIP_REQUEST, emoji: '✉️' },
      { name: FriendshipEvents.FRIENDSHIP_ACCEPT, emoji: '✅' },
      { name: FriendshipEvents.FRIENDSHIP_REJECT, emoji: '❌' },
      { name: FriendshipEvents.FRIENDSHIP_CANCEL, emoji: '🚫' },
    ],
  },
  {
    name: 'Business & Engagement',
    emoji: '💼',
    events: [
      { name: InviteEvents.CREATE_INVITE, emoji: '✉️' },
      { name: InviteEvents.DELETE_INVITE, emoji: '🗑️' },
      { name: RegInviteEvents.CREATE_REGINVITE, emoji: '✉️' },
      { name: RegInviteEvents.DELETE_REGINVITE, emoji: '🗑️' },
      { name: RegInviteEvents.UPDATE_REGINVITE, emoji: '✏️' },
      { name: RegInviteEvents.REFER_REGINVITE, emoji: '📢' },
      { name: RegInviteEvents.REGINVITE_USER_INVITE, emoji: '🤝' },
      { name: RegInviteEvents.MIGRATE_REGINVITE, emoji: '📨' },
      { name: FeedbackEvents.CREATE_FEEDBACK, emoji: '📝' },
      { name: FeedbackEvents.UPDATE_FEEDBACK, emoji: '✏️' },
      { name: FeedbackEvents.DELETE_FEEDBACK, emoji: '🗑️' },
      { name: FeedbackEvents.FEEDBACK_SENT, emoji: '📤' },
      { name: InboxEvents.CREATE_INBOX, emoji: '📥' },
      { name: InboxEvents.DELETE_INBOX, emoji: '🗑️' },
      { name: InboxEvents.READ_INBOX, emoji: '📬' },
      { name: ModalEvents.VIEW_MODAL, emoji: '👀' },
      { name: ModalEvents.AGREE_MODAL, emoji: '✅' },
      { name: ModalEvents.VIEW_BANNER, emoji: '👀' },
      { name: MiscEvents.ROLLED_DICE, emoji: '🎲' },
    ],
  },
  {
    name: 'Error Events',
    emoji: '⚠️',
    events: [
      { name: LLMEvents.MEMENTO_CREATION_ERROR, emoji: '❌' },
      { name: LLMEvents.QUEST_MASTER_ERROR, emoji: '❌' },
      { name: LLMEvents.AUTO_NAMING_ERROR, emoji: '❌' },
      { name: MiscEvents.DOWNLOAD_FAILED, emoji: '❌' },
    ],
  },
  {
    name: 'UI Navigation',
    emoji: '🧭',
    events: [
      { name: UiNavigationEvents.MORE_CREDITS_CLICKED, emoji: '💳' },
      { name: UiNavigationEvents.SUBSCRIBE_CLICKED, emoji: '⭐' },
      { name: UiNavigationEvents.PROFILE_CLICKED, emoji: '👤' },
      { name: UiNavigationEvents.WHATS_NEW_CLICKED, emoji: '✨' },
    ],
  },
];

function formatAIInsights(insights: string | string[] | null): { sections: string[]; hasContent: boolean } {
  if (!insights) {
    return { sections: [], hasContent: false };
  }

  const sections: string[] = [];
  const insightText = Array.isArray(insights) ? insights.join('\n') : insights;

  // Highlights
  const highlightsMatch = insightText.match(/Highlights:\n((?:[ \t]*-[^\n]*\n?)+)/);
  if (highlightsMatch) {
    sections.push('\n🎉 *Key Achievements*');
    const highlights = highlightsMatch[1]
      .trim()
      .split('\n')
      .map(point => point.trim().replace(/^-\s*/, ''))
      .filter(point => point.length > 0)
      .slice(0, 3); // Limit to top 3 for readability

    highlights.forEach((point, index) => {
      const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉';
      sections.push(`${emoji} ${point}`);
    });
  }

  // Concerns
  const concernsMatch = insightText.match(/Concerns:\n((?:[ \t]*-[^\n]*\n?)+)/);
  if (concernsMatch) {
    sections.push('\n⚠️ *Action Required*');
    const concerns = concernsMatch[1]
      .trim()
      .split('\n')
      .map(point => point.trim().replace(/^-\s*/, ''))
      .filter(point => point.length > 0)
      .slice(0, 3); // Limit to top 3 critical items

    concerns.forEach((point, index) => {
      const priority = index === 0 ? '🔴' : index === 1 ? '🟠' : '🟡';
      sections.push(`${priority} ${point}`);
    });
  }

  // Next Week's Focus
  const focusMatch = insightText.match(/Next Week's Focus:\n((?:[ \t]*-[^\n]*\n?)+)/);
  if (focusMatch) {
    sections.push('\n🎯 *Recommended Actions*');
    const focusPoints = focusMatch[1]
      .trim()
      .split('\n')
      .map(point => point.trim().replace(/^-\s*/, ''))
      .filter(point => point.length > 0)
      .slice(0, 3);

    focusPoints.forEach((point, index) => {
      sections.push(`${index + 1}. ${point}`);
    });
  }

  return { sections, hasContent: sections.length > 0 };
}

/**
 * Render the "Usage by Source" line as `web: 89% · cli: 10% · agent: 1%`.
 * Source order: web -> cli -> agent -> api -> system (any unknown sources appear
 * after these in their original sort order from the aggregation).
 */
export function formatUsageBySource(usage?: Array<{ source: CompletionSource; count: number }>): string | null {
  if (!usage || usage.length === 0) return null;
  const total = usage.reduce((sum, u) => sum + u.count, 0);
  if (total === 0) return null;
  const PREFERRED_ORDER: readonly CompletionSource[] = ['web', 'cli', 'agent', 'api', 'system'];
  const sorted = [...usage].sort((a, b) => {
    const ai = PREFERRED_ORDER.indexOf(a.source);
    const bi = PREFERRED_ORDER.indexOf(b.source);
    if (ai === -1 && bi === -1) return b.count - a.count;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return sorted.map(({ source, count }) => `${source}: ${((count / total) * 100).toFixed(1)}%`).join(' · ');
}

export const formatCustomSlackMessage = (
  appName: string,
  data: {
    metrics: Record<string, KpiMetrics>;
    userActivity: UserActivityMetrics;
    aiInsights?: string | string[] | null;
    date?: string;
    usageBySource?: Array<{ source: CompletionSource; count: number }>;
  }
): string => {
  const { metrics, userActivity, aiInsights, date, usageBySource } = data;

  const formatChange = (change: number): string => {
    if (change === 0) return ' ⏸️ (0%)';
    if (change > 20) return ` 🚀 (+${change.toFixed(1)}%)`;
    if (change > 0) return ` ↗️ (+${change.toFixed(1)}%)`;
    if (change < -20) return ` 📉 (${change.toFixed(1)}%)`;
    return ` ↘️ (${change.toFixed(1)}%)`;
  };

  const getHealthIndicator = (change: number): string => {
    if (change > 50) return '🟢';
    if (change > 20) return '🟡';
    if (change > 0) return '🟠';
    if (change > -20) return '🟡';
    return '🔴';
  };

  const sections = [];

  // Header
  const reportDate = date ? dayjs(date) : dayjs();
  const totalEvents = Object.values(metrics).reduce((sum, m) => sum + (m?.weeklyTotal || 0), 0);
  const lastWeekTotal = Object.values(metrics).reduce((sum, m) => sum + (m?.lastWeekTotal || 0), 0);
  const overallChange = lastWeekTotal > 0 ? ((totalEvents - lastWeekTotal) / lastWeekTotal) * 100 : 0;

  sections.push(`🎯 *Daily Analytics Report - ${appName}*`);
  sections.push(`📅 ${reportDate.utc().format('MMMM D, YYYY')} • ${reportDate.utc().format('HH:mm')} UTC`);
  sections.push('═══════════════════════════');

  // Quick Summary Section
  const activeModels = userActivity.topModels?.length || 0;
  const activeUsers24h = userActivity.topUsers?.length || 0;

  // Calculate DAU/WAU metrics
  const dau = activeUsers24h; // Daily Active Users from last 24h
  const wau = userActivity.totalUniqueUsers || 0; // Weekly Active Users from last 7 days
  const dauWauRatioNum = wau > 0 ? (dau / wau) * 100 : 0;
  const dauWauRatio = dauWauRatioNum.toFixed(1);
  const engagementHealth = dauWauRatioNum > 40 ? '🟢' : dauWauRatioNum > 25 ? '🟡' : dauWauRatioNum > 10 ? '🟠' : '🔴';

  sections.push('\n📊 *24-Hour Snapshot*');
  sections.push(`• Active Users: *${activeUsers24h}* users`);
  sections.push(`• Models Used: *${activeModels}* different models`);
  sections.push(
    `• Health Score: ${getHealthIndicator(overallChange)} ${overallChange > 0 ? '↑' : overallChange < 0 ? '↓' : '→'} ${Math.abs(overallChange).toFixed(1)}% from last week`
  );
  const sourceLine = formatUsageBySource(usageBySource);
  if (sourceLine) {
    sections.push(`• Usage by Source: ${sourceLine}`);
  }
  sections.push('───────────────────────────');

  // Add DAU/WAU Active User Metrics
  sections.push('\n👥 *Active User Metrics*');
  sections.push(`🎯 Daily Active (DAU): *${dau}* users`);
  sections.push(`📊 Weekly Active (WAU): *${wau}* users`);
  sections.push(
    `📈 DAU/WAU Ratio: ${engagementHealth} ${dauWauRatio}% ${dauWauRatioNum > 40 ? 'Excellent' : dauWauRatioNum > 25 ? 'Good' : dauWauRatioNum > 10 ? 'Needs Attention' : 'Critical'}`
  );

  // Add activity breakdown if available
  if (metrics && Object.keys(metrics).length > 0) {
    const sessionCreators = metrics[SessionEvents.CREATE_SESSION]?.weeklyTotal || 0;
    const aiUsersToday = userActivity.topModels ? userActivity.topModels.reduce((sum, m) => sum + m.count, 0) : 0;
    const fileActivity =
      (metrics[FileEvents.FILE_UPLOADED]?.weeklyTotal || 0) + (metrics[FileEvents.CREATE_FILE]?.weeklyTotal || 0);

    if (sessionCreators > 0 || aiUsersToday > 0 || fileActivity > 0) {
      sections.push(
        `💡 Weekly: ${sessionCreators} sessions | 🤖 Today: ${aiUsersToday} AI requests | 📁 Weekly: ${fileActivity} files`
      );
    }
  }
  sections.push('───────────────────────────');

  // AI Insights
  if (aiInsights) {
    sections.push('🧠 *AI-Powered Insights*');
    const { sections: insightSections } = formatAIInsights(aiInsights);
    if (insightSections.length > 0) {
      sections.push(...insightSections);
    } else {
      sections.push('_No significant patterns detected today_');
    }
    sections.push('───────────────────────────');
  }

  // Event groups
  sections.push('📊 *Activity Breakdown (7-Day Metrics)*');

  let hasActiveGroups = false;
  EVENT_GROUPS.forEach(group => {
    // Sort events by weekly total (descending)
    const sortedEvents = group.events
      .filter(event => {
        const metric = metrics[event.name];
        return metric && metric.weeklyTotal > 0;
      })
      .sort((a, b) => {
        const metricA = metrics[a.name];
        const metricB = metrics[b.name];
        return (metricB?.weeklyTotal || 0) - (metricA?.weeklyTotal || 0);
      });

    // Only show group if it has events with data
    if (sortedEvents.length > 0) {
      hasActiveGroups = true;
      const groupTotal = sortedEvents.reduce((sum, event) => {
        const metric = metrics[event.name];
        return sum + (metric?.weeklyTotal || 0);
      }, 0);

      sections.push(`\n${group.emoji} *${group.name}* _(${groupTotal} total events)_`);

      // Show top 3 events per group for better readability
      sortedEvents.slice(0, 3).forEach(event => {
        const metric = metrics[event.name];
        if (metric) {
          const trend = metric.weekOverWeekChange > 0 ? '📈' : metric.weekOverWeekChange < 0 ? '📉' : '➡️';
          sections.push(
            `  ${event.emoji} ${event.name}: *${metric.weeklyTotal}* ${trend} (${metric.lastWeekTotal} last week)${formatChange(metric.weekOverWeekChange)}`
          );
        }
      });

      if (sortedEvents.length > 3) {
        sections.push(`  _...and ${sortedEvents.length - 3} more events_`);
      }
    }
  });

  if (!hasActiveGroups) {
    sections.push('_No activity recorded in the last 7 days_');
  }

  sections.push('\n───────────────────────────');

  // Top models
  sections.push('\n🤖 *AI Model Usage (Last 24H)*');
  if (userActivity.topModels && userActivity.topModels.length > 0) {
    const totalModelRequests = userActivity.topModels.reduce((sum, m) => sum + m.count, 0);
    userActivity.topModels.slice(0, 5).forEach((model, index) => {
      let medal = '  •';
      if (index === 0) medal = '🥇';
      if (index === 1) medal = '🥈';
      if (index === 2) medal = '🥉';
      const percentage = ((model.count / totalModelRequests) * 100).toFixed(1);
      const bar = generateProgressBar(model.count / totalModelRequests);
      sections.push(`${medal} ${model.modelName}`);
      sections.push(`     ${bar} ${model.count.toLocaleString()} requests (${percentage}%)`);
    });
  } else {
    sections.push('_No model usage recorded in the last 24 hours_');
  }

  sections.push('\n───────────────────────────');

  // Top users
  sections.push('\n👥 *Most Active Users (Last 24H)*');
  if (userActivity.topUsers && userActivity.topUsers.length > 0) {
    const topUsers = userActivity.topUsers.slice(0, 10); // Show top 10 instead of 20 for better readability
    const maxInteractions = topUsers[0].interactions;

    topUsers.forEach((user, index) => {
      let medal = '  •';
      if (index === 0) medal = '🏆';
      if (index === 1) medal = '🥈';
      if (index === 2) medal = '🥉';

      const displayName = user.email || `User ${user._id?.substring(0, 8)}`;
      const engagementLevel = getEngagementLevel(user.interactions, maxInteractions);
      sections.push(`${medal} ${displayName}`);
      sections.push(`     ${engagementLevel} ${user.interactions.toLocaleString()} events`);
    });

    if (userActivity.topUsers.length > 10) {
      sections.push(`\n  _...and ${userActivity.topUsers.length - 10} more active users_`);
    }
  } else {
    sections.push('_No user activity recorded in the last 24 hours_');
  }

  sections.push('\n───────────────────────────');

  // User activity summary
  sections.push('\n📈 *User Engagement Overview (7 Days)*');

  const internalPercentage =
    userActivity.totalUniqueUsers > 0
      ? ((userActivity.internalUsers / userActivity.totalUniqueUsers) * 100).toFixed(1)
      : 0;
  const externalPercentage =
    userActivity.totalUniqueUsers > 0
      ? ((userActivity.externalUsers / userActivity.totalUniqueUsers) * 100).toFixed(1)
      : 0;

  sections.push(`• Total Active Users: *${userActivity.totalUniqueUsers}*`);
  sections.push(`• Internal Team: ${userActivity.internalUsers} users (${internalPercentage}%) 🏢`);
  sections.push(`• External Users: ${userActivity.externalUsers} users (${externalPercentage}%) 🌍`);

  // Add quick insights
  if (userActivity.totalUniqueUsers > 0) {
    const avgEventsPerUser = totalEvents / userActivity.totalUniqueUsers;
    sections.push(`• Avg Events/User: ${avgEventsPerUser.toFixed(1)} ${getActivityHealthIndicator(avgEventsPerUser)}`);
  }

  sections.push('\n═══════════════════════════');
  sections.push('_💡 Reply with "details" for expanded metrics_');

  return sections.join('\n');
};

function generateProgressBar(percentage: number): string {
  const filled = Math.round(percentage * 10);
  const empty = 10 - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

function getEngagementLevel(interactions: number, max: number): string {
  const percentage = (interactions / max) * 100;
  if (percentage >= 80) return '🔥';
  if (percentage >= 60) return '⚡';
  if (percentage >= 40) return '✨';
  if (percentage >= 20) return '💫';
  return '⭐';
}

function getActivityHealthIndicator(avgEvents: number): string {
  if (avgEvents >= 50) return '🔥 Excellent';
  if (avgEvents >= 30) return '✨ Good';
  if (avgEvents >= 15) return '👍 Moderate';
  if (avgEvents >= 5) return '📊 Low';
  return '⚠️ Very Low';
}

export function formatWeeklySlackMessage(appName: string, data: WeeklyReportData): string {
  const sections: string[] = [];
  let nextWeekFocus: string[] = [];

  // App name and date range header
  sections.push(`⭐ *Weekly Analytics Report - ${appName}*`);
  const startDateFormatted = dayjs(data.weekStart).format('MMM DD');
  const endDateFormatted = dayjs(data.weekEnd).format('MMM DD, YYYY');
  sections.push(`📅 ${startDateFormatted} - ${endDateFormatted}`);
  sections.push('───────────────────────────');

  // AI Insights section - but save Next Week's Focus for later
  if (data.aiInsights) {
    sections.push("🔍 *Week's Key Insights*");
    const { sections: insightSections } = formatAIInsights(data.aiInsights);

    // Filter out Next Week's Focus section to add it at the end
    const focusIndex = insightSections.findIndex(s => s.includes("Next Week's Focus"));
    if (focusIndex !== -1) {
      nextWeekFocus = insightSections.slice(focusIndex, focusIndex + 2);
      sections.push(...insightSections.slice(0, focusIndex));
    } else {
      sections.push(...insightSections);
    }
    sections.push('───────────────────────────');
  }

  // Weekly Trend by Group section
  sections.push('📊 *Weekly Trends by Group*');
  EVENT_GROUPS.forEach(group => {
    const groupEvents = group.events
      .filter(event => {
        const metric = data.metrics[event.name];
        return metric && (metric.weeklyTotal > 0 || metric.lastWeekTotal > 0);
      })
      .sort((a, b) => {
        const metricA = data.metrics[a.name];
        const metricB = data.metrics[b.name];
        return (metricB?.weeklyTotal || 0) - (metricA?.weeklyTotal || 0);
      });

    if (groupEvents.length > 0) {
      sections.push(`${group.emoji} *${group.name}*`);
      groupEvents.forEach(event => {
        const metric = data.metrics[event.name];
        if (metric) {
          const weekChange = metric.weekOverWeekChange;
          const weekIcon = weekChange > 0 ? '⬆️' : weekChange < 0 ? '⬇️' : '⏺️';
          const fourWeekChange = metric.fourWeekAverageChange;
          const fourWeekIcon = fourWeekChange > 0 ? '⬆️' : fourWeekChange < 0 ? '⬇️' : '⏺️';
          sections.push(
            `${event.emoji} ${event.name}: ${metric.weeklyTotal} vs ${metric.lastWeekTotal} last week ${weekIcon} (${weekChange > 0 ? '+' : ''}${weekChange.toFixed(2)}%) vs ${metric.fourWeekAverage.toFixed(2)} ave past 4 weeks ${fourWeekIcon} (${fourWeekChange > 0 ? '+' : ''}${fourWeekChange.toFixed(2)}%)`
          );
        }
      });
    }
  });
  sections.push('───────────────────────────');

  // Peak Activity section
  Logger.globalInstance.log('Before peak activity section check:', {
    condition: !!(data.peakDay || data.peakTime || data.lastWeekPeakDay || data.lastWeekPeakTime),
    'data.peakDay exists': !!data.peakDay,
    'data.peakTime exists': !!data.peakTime,
    'data.lastWeekPeakDay exists': !!data.lastWeekPeakDay,
    'data.lastWeekPeakTime exists': !!data.lastWeekPeakTime,
  });

  if (data.peakDay || data.peakTime || data.lastWeekPeakDay || data.lastWeekPeakTime) {
    Logger.globalInstance.log('Formatting Peak Activity Data:', {
      peakDay: data.peakDay,
      peakTime: data.peakTime,
      lastWeekPeakDay: data.lastWeekPeakDay,
      lastWeekPeakTime: data.lastWeekPeakTime,
    });

    sections.push('📊 *Peak Activity*');

    // Current week peak day
    if (data.peakDay) {
      const currentDay = dayjs(data.peakDay.date);
      const dayName = currentDay.format('ddd');
      const formattedDate = currentDay.format('MMM DD, YYYY');
      const lastWeekInfo = data.lastWeekPeakDay
        ? ` (Last week: ${dayjs(data.lastWeekPeakDay.date).format('MMM DD')} (${dayjs(data.lastWeekPeakDay.date).format('ddd')}) with ${data.lastWeekPeakDay.totalEvents.toLocaleString()} events)`
        : '';
      sections.push(
        `Most Active Day: ${formattedDate} (${dayName}) with ${data.peakDay.totalEvents.toLocaleString()} events${lastWeekInfo}`
      );
    }

    // Current week peak hour
    if (data.peakTime) {
      const hour = data.peakTime.hour;
      const formattedHour = dayjs().hour(hour).utc().format('HH:mm UTC');
      const lastWeekInfo = data.lastWeekPeakTime
        ? ` (Last week: ${dayjs().hour(data.lastWeekPeakTime.hour).utc().format('HH:mm UTC')} with an average of ${Math.round(data.lastWeekPeakTime.avgEvents).toLocaleString()} events/day)`
        : '';
      sections.push(
        `Peak Usage Time: ${formattedHour} with an average of ${Math.round(data.peakTime.avgEvents).toLocaleString()} events/day${lastWeekInfo}`
      );
    }

    sections.push('───────────────────────────');
  }

  // Usage by Source
  const weeklySourceLine = formatUsageBySource(data.usageBySource);
  if (weeklySourceLine) {
    sections.push('🌐 *Usage by Source*');
    sections.push(weeklySourceLine);
    sections.push('───────────────────────────');
  }

  // Top Organizations section
  if (data.topOrganizations && data.topOrganizations.length > 0) {
    sections.push('👑 *Most Active Organizations*');
    data.topOrganizations.forEach((org, index) => {
      const medal = getMedalEmoji(index);
      const rankChange = getRankChangeSymbol(org.rankChange);
      const lastWeekRank =
        typeof org.lastWeekRank === 'number' ? `#${org.lastWeekRank}` : org.lastWeekRank === 'new' ? 'New' : '>#10';
      sections.push(`${medal} ${org.name}: ${org.events} events ${rankChange} (Last Week: ${lastWeekRank})`);
    });
    sections.push('───────────────────────────');
  }

  // Top Models section
  if (data.userActivity.topModels?.length > 0) {
    sections.push('🤖 *Top 3 Models Used*');
    data.userActivity.topModels.forEach((model, index) => {
      const medal = getMedalEmoji(index);
      const rankChange = getRankChangeSymbol(model.rankChange);
      const lastWeekRank =
        typeof model.lastWeekRank === 'number'
          ? `#${model.lastWeekRank}`
          : model.lastWeekRank === 'new'
            ? 'New'
            : '>#10';
      sections.push(`${medal} ${model.modelName}: ${model.count} requests ${rankChange} (Last Week: ${lastWeekRank})`);
    });
  }
  sections.push('───────────────────────────');

  // Top Users section
  if (data.userActivity.topUsers?.length > 0) {
    sections.push('🏆 *Top Performers This Week*');
    data.userActivity.topUsers.forEach((user, index) => {
      const medal = getMedalEmoji(index);
      const rankChange = getRankChangeSymbol(user.rankChange);
      const lastWeekRank =
        typeof user.lastWeekRank === 'number' ? `#${user.lastWeekRank}` : user.lastWeekRank === 'new' ? 'New' : '>#20';
      const displayName = user.email || 'Unknown User';
      sections.push(`${medal} ${displayName}: ${user.interactions} events ${rankChange} (Last Week: ${lastWeekRank})`);
    });
    sections.push('───────────────────────────');
  }

  // Add Next Week's Focus at the very end
  if (nextWeekFocus.length > 0) {
    sections.push(...nextWeekFocus);
  }

  return sections.join('\n');
}

const getRankChangeSymbol = (change?: string) => {
  switch (change) {
    case 'up':
      return '⬆️';
    case 'down':
      return '⬇️';
    case 'same':
      return '⏺️';
    case 'new':
      return '🆕';
    default:
      return '⏺️';
  }
};

const getMedalEmoji = (index: number) => {
  switch (index) {
    case 0:
      return '🥇';
    case 1:
      return '🥈';
    case 2:
      return '🥉';
    default:
      return '🏆';
  }
};
