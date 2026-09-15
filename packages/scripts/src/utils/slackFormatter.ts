/**
 * Slack message formatting utilities using Block Kit
 */

interface ChangelogSection {
  type: 'features' | 'fixes' | 'performance' | 'internal' | 'hotfix';
  items: string[];
}

interface Changelog {
  title: string;
  sections: ChangelogSection[];
  briefSummary: string[];
  metadata: {
    commitCount: number;
    prNumber: number | null;
    prNumbers: number[];
    deployedAt: string;
    deployNumber: number;
  };
}

interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  elements?: Array<{
    type: string;
    text?: string;
    emoji?: boolean;
    url?: string;
  }>;
  fields?: Array<{
    type: string;
    text: string;
  }>;
}

interface SlackMessage {
  blocks: SlackBlock[];
}

/**
 * Get emoji for section type
 */
function getSectionEmoji(type: ChangelogSection['type']): string {
  const emojiMap = {
    features: '🎯',
    fixes: '🐛',
    performance: '⚡',
    internal: '🔧',
    hotfix: '🔥',
  };
  return emojiMap[type] || '•';
}

/**
 * Format the deployment timestamp
 */
function formatTimestamp(isoDate: string): string {
  const date = new Date(isoDate);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;

  return `${month} ${day}, ${displayHours}:${minutes} ${ampm}`;
}

/**
 * Format changelog as Slack Block Kit message
 */
export function formatSlackMessage(
  changelog: Changelog,
  version: string,
  releaseUrl: string,
  repoUrl: string,
  appName?: string
): SlackMessage {
  const blocks: SlackBlock[] = [];

  // Header with app name
  const deployNumber = changelog.metadata.deployNumber;
  const deployText = deployNumber > 1 ? ` · Deploy #${deployNumber} today` : '';
  const appPrefix = appName ? `[${appName}] ` : '';

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `🚀 ${appPrefix}Production Deploy ${version}${deployText}`,
      emoji: true,
    },
  });

  // Release title as subtitle
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${changelog.title}*`,
    },
  });

  // Categorized changes (more informative than brief summary)
  const priorityOrder: ChangelogSection['type'][] = ['hotfix', 'features', 'fixes', 'performance', 'internal'];
  let totalItems = 0;
  const maxItemsPerSection = 3;
  const maxTotalItems = 8;

  for (const type of priorityOrder) {
    const section = changelog.sections.find(s => s.type === type);
    if (section && section.items.length > 0 && totalItems < maxTotalItems) {
      const emoji = getSectionEmoji(type);
      const sectionName = type.charAt(0).toUpperCase() + type.slice(1);
      const itemsToShow = Math.min(maxItemsPerSection, maxTotalItems - totalItems, section.items.length);
      const remainingItems = section.items.length - itemsToShow;

      let sectionText = `*${emoji} ${sectionName}*\n`;
      sectionText += section.items
        .slice(0, itemsToShow)
        .map(item => `• ${item}`)
        .join('\n');

      if (remainingItems > 0) {
        sectionText += `\n_...and ${remainingItems} more_`;
      }

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: sectionText,
        },
      });

      totalItems += itemsToShow;
    }
  }

  // Divider
  blocks.push({ type: 'divider' });

  // Metadata and links
  const { commitCount, prNumbers } = changelog.metadata;
  const timestamp = formatTimestamp(changelog.metadata.deployedAt);

  // PR links
  const prLinks =
    prNumbers.length > 0
      ? prNumbers
          .slice(0, 10) // Limit to first 10 PRs to avoid too long message
          .map(pr => `<${repoUrl}/pull/${pr}|#${pr}>`)
          .join(', ')
      : null;

  const remainingPRs = prNumbers.length > 10 ? ` +${prNumbers.length - 10} more` : '';

  const metadataText = [
    `<${releaseUrl}|📦 *View Full Release Notes*>`,
    prLinks ? `*PRs:* ${prLinks}${remainingPRs}` : null,
    `📊 ${commitCount} commit${commitCount !== 1 ? 's' : ''}`,
    `⏱️ ${timestamp}`,
  ]
    .filter(Boolean)
    .join('\n');

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: metadataText,
      },
    ],
  });

  return { blocks };
}

/**
 * Send message to Slack webhook
 */
export async function sendSlackNotification(
  message: SlackMessage,
  webhookUrl: string,
  retries: number = 3
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Slack webhook error (${response.status}): ${errorText}`);
      }

      console.log('✅ Slack notification sent successfully');
      return;
    } catch (error) {
      lastError = error as Error;
      console.error(`Slack notification attempt ${attempt} failed:`, error);

      if (attempt < retries) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // Don't throw - we don't want to fail the release if Slack is down
  console.error('❌ Failed to send Slack notification after all retries:', lastError);
}

/**
 * Create a brief summary suitable for Slack from changelog sections
 */
export function createBriefSummary(sections: ChangelogSection[]): string[] {
  const summary: string[] = [];

  // Prioritize: features, fixes, performance, hotfix, then internal
  const priorityOrder: ChangelogSection['type'][] = ['hotfix', 'features', 'fixes', 'performance', 'internal'];

  for (const type of priorityOrder) {
    const section = sections.find(s => s.type === type);
    if (section && section.items.length > 0) {
      const emoji = getSectionEmoji(type);
      // Take up to 2 items from each section
      section.items.slice(0, 2).forEach(item => {
        if (summary.length < 5) {
          // Max 5 total items
          summary.push(`${emoji} ${item}`);
        }
      });
    }
  }

  return summary;
}
