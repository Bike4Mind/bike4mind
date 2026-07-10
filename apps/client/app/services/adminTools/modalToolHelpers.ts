import { AdminToolResult, AdminToolParams, IModal, IChatHistoryItem, AdminToolAttachment } from '@bike4mind/common';

/**
 * Shared helper functions for ModalManagementTool
 * These are pure functions that work on both client and server
 */

// Show help information
export function showHelp(): AdminToolResult {
  const helpText = `
# Admin Modal Management Tool

## Available Commands:

### Basic Commands
- \`/admin\` or \`/admin help\` - Show this help message
- \`/admin modal create\` - Create a new modal
- \`/admin modal from-context\` - Create a modal from recent chat history
- \`/admin modal list\` - List all modals
- \`/admin modal trigger <id or title>\` - Show/trigger a modal
- \`/admin modal delete <id>\` - Delete a modal
- \`/admin modal edit <id>\` - Edit an existing modal

### Natural Language Commands
You can also use natural language:
- "Create a modal for the new feature announcement"
- "Make a banner about maintenance"
- "Show me all active modals"
- "Trigger modal California" or "Show banner welcome"
- "Create a modal from the conversation above"
- "Create a banner from context"

## Available Flags:

### Basic Properties
- \`--type <modal|banner>\` - Type of notification
- \`--title <text>\` - Title of the modal
- \`--subtitle <text>\` - Subtitle (modals only)
- \`--description <text>\` - Description/body content
- \`--message <text>\` - Text message (for banners)

### Display Options
- \`--enabled <true|false>\` - Enable/disable immediately (default: false)
- \`--priority <0-10>\` - Priority level (default: 5, 10 is highest)
- \`--closeButton <true|false>\` - Show close button (default: true)
- \`--agreeButton <true|false>\` - Show agree button (default: true for modals, false for banners)

### Targeting
- \`--tags <tag1,tag2>\` - Comma-separated user tags (e.g., new-user,premium)

### Scheduling
- \`--startDate <YYYY-MM-DD>\` - When to start showing (default: today)
- \`--endDate <YYYY-MM-DD>\` - When to stop showing (default: 7 days from now)

### Media
- \`--image <url>\` - Image URL to display

## Examples:

### Simple Commands
\`\`\`
/admin modal create --type banner --title "Hello World"
/admin modal create --type modal --title "Welcome" --description "Get started!"
\`\`\`

### Full Configuration
\`\`\`
/admin modal create --type modal --title "Welcome" --subtitle "Get Started" --description "Welcome to our platform!" --priority 8 --enabled true --tags new-user,beta-tester
\`\`\`

### Scheduled Banner
\`\`\`
/admin modal create --type banner --message "Maintenance tonight" --startDate 2025-10-22 --endDate 2025-10-23 --priority 10
\`\`\`

### With Image
\`\`\`
/admin modal create --type modal --title "New Feature" --description "Check this out!" --image https://example.com/image.png
\`\`\`

## Notes:

- **Quotes**: Only needed if the value contains spaces
  - OK: \`--title Hi\`
  - Needed: \`--title "Hello World"\`
- **Boolean values**: Can be \`true\` or \`false\`
- **Comma-separated**: For \`--tags\`, use commas with no spaces: \`tag1,tag2,tag3\`
- **Dates**: Must be in \`YYYY-MM-DD\` format
- **Default behavior**: All modals are created disabled by default for safety
- **Natural language**: Mix flags with natural language: \`create welcome message --title "Custom Title"\`
      `.trim();

  return {
    success: true,
    type: 'help',
    data: helpText,
  };
}

// Parse natural language intent
export function parseModalIntent(query: string): {
  type?: 'modal' | 'banner';
  priority?: number;
  startDate?: string;
  endDate?: string;
  tags?: string[];
} {
  const intent: {
    type?: 'modal' | 'banner';
    priority?: number;
    startDate?: string;
    endDate?: string;
    tags?: string[];
  } = {};
  const lower = query.toLowerCase();

  // Detect type
  if (lower.includes('banner')) {
    intent.type = 'banner';
  } else if (lower.includes('modal')) {
    intent.type = 'modal';
  }

  // Detect urgency/priority
  if (lower.includes('urgent') || lower.includes('important') || lower.includes('critical')) {
    intent.priority = 10;
  } else if (lower.includes('high priority')) {
    intent.priority = 8;
  }

  // Detect dates
  const tomorrowMatch = lower.match(/tomorrow/);
  if (tomorrowMatch) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    intent.startDate = tomorrow.toISOString().split('T')[0];
  }

  const nextWeekMatch = lower.match(/next week/);
  if (nextWeekMatch) {
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    intent.startDate = nextWeek.toISOString().split('T')[0];
  }

  // Detect target audience
  if (lower.includes('premium') || lower.includes('paid')) {
    intent.tags = ['premium'];
  } else if (lower.includes('new user')) {
    intent.tags = ['new-user'];
  } else if (lower.includes('everyone') || lower.includes('all user')) {
    intent.tags = [];
  }

  return intent;
}

// Generate title from params
export function generateTitle(params: { intent?: string; summary?: string }): string {
  // First try to extract title from the intent
  if (params.intent) {
    // Look for explicit title patterns
    const patterns = [
      /title[:\s]+["']?(.+?)["']?(?:,|$)/i,
      /called[:\s]+["']?(.+?)["']?(?:,|$)/i,
      /named[:\s]+["']?(.+?)["']?(?:,|$)/i,
    ];

    for (const pattern of patterns) {
      const match = params.intent.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    // For simple requests, use the main content as title
    if (params.intent.toLowerCase().includes('hello world')) {
      return 'Hello World!';
    }
  }

  // Smart title generation based on context
  if (params.summary?.includes('feature')) {
    return '🚀 Exciting New Feature!';
  }
  if (params.summary?.includes('maintenance')) {
    return '🔧 Scheduled Maintenance';
  }
  if (params.summary?.includes('update')) {
    return '📢 Important Update';
  }
  return '📣 Announcement';
}

// Generate subtitle
export function generateSubtitle(_params: { intent?: string; summary?: string }): string {
  return "Learn more about what's new";
}

// Generate banner message
export function generateBannerMessage(params: { intent?: string; summary?: string }): string {
  // First, try to extract the message from the intent/query
  if (params.intent) {
    // Look for patterns like "that says X", "saying X", "with message X"
    const patterns = [
      /that says[:\s]+(.+)/i,
      /saying[:\s]+(.+)/i,
      /with message[:\s]+(.+)/i,
      /with text[:\s]+(.+)/i,
      /banner[:\s]+["']?(.+?)["']?$/i,
      /message[:\s]+["']?(.+?)["']?$/i,
    ];

    for (const pattern of patterns) {
      const match = params.intent.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }

    // If it's a simple phrase like "hello world banner", extract the message
    if (params.intent.toLowerCase().includes('banner')) {
      const text = params.intent.replace(/banner/gi, '').trim();
      if (text && !text.includes('create') && !text.includes('make') && !text.includes('new')) {
        return text;
      }
    }
  }

  if (params.summary?.includes('maintenance')) {
    return '⚠️ Scheduled maintenance planned. Click for details.';
  }
  return '📢 We have an important update for you!';
}

// Generate description
export function generateDescription(params: { intent?: string; summary?: string }): string {
  // Try to extract description from the intent
  if (params.intent) {
    // Look for descriptive content
    const patterns = [/description[:\s]+["']?(.+?)["']?$/i, /about[:\s]+(.+)/i, /for[:\s]+(.+)/i];

    for (const pattern of patterns) {
      const match = params.intent.match(pattern);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }

  return (
    params.summary || "We're excited to share this update with you. This enhancement will improve your experience."
  );
}

// Suggest tags based on modal content
export function suggestTags(modal: Partial<IModal>): string[] {
  const content = `${modal.title} ${modal.description} ${modal.textMessage}`.toLowerCase();
  const tags: string[] = [];

  if (content.includes('premium') || content.includes('pro')) {
    tags.push('premium');
  }
  if (content.includes('new') || content.includes('launch')) {
    tags.push('new-feature');
  }
  if (content.includes('maintenance') || content.includes('downtime')) {
    tags.push('system');
  }

  return tags.length > 0 ? tags : ['all-users'];
}

// Build modal from parameters
export function buildModalFromParams(params: AdminToolParams): Partial<IModal> {
  const data = (params.data as Record<string, unknown>) || {};
  const options = params.options || {};

  // Options take priority over data
  const isBanner = options.type === 'banner' || data.type === 'banner';
  const priority = options.priority ? parseInt(String(options.priority)) : (data.priority as number) || 5;
  const enabled = options.enabled !== undefined ? options.enabled === 'true' || options.enabled === true : false;

  // Use different default titles for banners vs modals
  const defaultTitle = isBanner ? 'Announcement' : 'New Modal';

  return {
    title: (options.title as string) || (data.title as string) || defaultTitle,
    subtitle: (options.subtitle as string) || (data.subtitle as string),
    description: (options.description as string) || (data.description as string) || '',
    textMessage: (options.message as string) || (data.textMessage as string), // For banners
    isBanner,
    imageUrl: (options.image as string) || (data.imageUrl as string),
    tags: options.tags ? String(options.tags).split(',') : (data.tags as string[]) || [],
    priority,
    enabled,
    closeButton:
      options.closeButton !== undefined ? options.closeButton === 'true' || options.closeButton === true : true,
    agreeButton:
      options.agreeButton !== undefined ? options.agreeButton === 'true' || options.agreeButton === true : !isBanner,
    startDate: (options.startDate as string) || (data.startDate as string) || new Date().toISOString().split('T')[0],
    endDate:
      (options.endDate as string) ||
      (data.endDate as string) ||
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    numberOfViews: {
      type: 'defaultView',
      value: 0,
      threshold: 3,
      tags: [],
    },
    numberOfAgrees: {
      type: 'defaultAgree',
      value: 0,
      threshold: 1,
      tags: [],
    },
  };
}

// Extract images from chat history
export function extractImagesFromChat(messages: IChatHistoryItem[]): string[] {
  const images: string[] = [];

  messages.forEach(msg => {
    // Cast to unknown first to allow checking for extended properties
    const msgWithExtras = msg as unknown as {
      type?: string;
      url?: string;
      attachments?: Array<{ type?: string; url?: string }>;
    };

    // Look for image generation results
    if (msgWithExtras.type === 'image' && msgWithExtras.url) {
      images.push(msgWithExtras.url);
    }

    // Look for attached images
    if (msgWithExtras.attachments) {
      msgWithExtras.attachments.forEach(att => {
        if (att.type === 'image' && att.url) {
          images.push(att.url);
        }
      });
    }

    // NOTE: IChatHistoryItem.images is intentionally NOT read here. It holds
    // storage bucket keys (not URLs) and can include non-image artifacts, so it
    // would need key filtering + URL resolution before it could feed imageUrl.
    // Only the {type:'image'|attachments} shapes above carry ready-to-use URLs.
  });

  return images;
}

// Summarize chat context
export function summarizeChatContext(messages: IChatHistoryItem[]): string {
  // Simple summarization - in production, use LLM.
  // Reads both the legacy {content,text} shape and the real IChatHistoryItem
  // {prompt,reply/replies} shape so real chat history is actually reflected.
  const texts = messages
    .map(m => {
      const extra = m as unknown as {
        content?: string;
        text?: string;
        reply?: string | null;
        replies?: string[];
      };
      const reply = extra.reply || extra.replies?.find(Boolean);
      return [extra.content, extra.text, m.prompt, reply].filter(Boolean).join(' ').trim();
    })
    .filter(Boolean);
  return texts.join(' ').slice(-500); // Last 500 chars
}

// AI-powered modal content generation (template-based for now)
export function aiGenerateModalContent(params: {
  summary?: string;
  images?: string[];
  type: 'modal' | 'banner';
  intent: string;
  title?: string;
  description?: string;
}): Partial<IModal> {
  const isBanner = params.type === 'banner';

  const baseModal: Partial<IModal> = {
    isBanner,
    closeButton: true,
    agreeButton: !isBanner,
    priority: 5,
    enabled: false,
  };

  if (isBanner) {
    baseModal.textMessage = params.title || generateBannerMessage(params);
    baseModal.description = params.description || generateDescription(params);
  } else {
    baseModal.title = params.title || generateTitle(params);
    baseModal.subtitle = generateSubtitle(params);
    baseModal.description = params.description || generateDescription(params);
  }

  // Add images if provided
  if (params.images && params.images.length > 0) {
    baseModal.imageUrl = params.images[0];
    if (params.images.length > 1) {
      baseModal.images = params.images.slice(1).map(url => ({
        url,
        width: undefined,
        height: undefined,
      }));
    }
  }

  // Set up counters
  baseModal.numberOfViews = {
    type: 'standardView',
    value: 0,
    threshold: 3,
    tags: [],
  };

  baseModal.numberOfAgrees = {
    type: 'standardAgree',
    value: 0,
    threshold: 1,
    tags: [],
  };

  return baseModal;
}

// Shown when a from-context request has no recent chat to summarize, so callers
// surface a clear message instead of a generic empty modal.
export const NO_CHAT_CONTEXT_MESSAGE =
  'No recent chat context found to build a modal from. Have a conversation (or attach an image) first, then try `/admin modal from-context` again.';

// Build modal content from recent chat context. Returns null when there is no
// usable context (no text and no images) so callers can surface a clear
// "nothing to summarize" message rather than a generic empty modal.
export function generateModalContentFromContext(
  messages: IChatHistoryItem[],
  options: { type?: 'modal' | 'banner'; intent?: string } = {}
): Partial<IModal> | null {
  const summary = summarizeChatContext(messages);
  const images = extractImagesFromChat(messages);

  if (!summary.trim() && images.length === 0) {
    return null;
  }

  return aiGenerateModalContent({
    summary,
    images,
    type: options.type || 'modal',
    intent: options.intent || '',
  });
}

// Generate modal from natural language
export function generateModalFromNaturalLanguage(
  query: string,
  data?: Record<string, unknown>,
  options?: Record<string, unknown>,
  attachments?: AdminToolAttachment[]
): Partial<IModal> {
  // Strip flags from query to get clean natural language content
  const cleanQuery = query.replace(/--\w+(?:\s+(?:"[^"]*"|'[^']*'|\S+))?/g, '').trim();

  // If query is empty after removing flags, use options directly
  if (!cleanQuery && options) {
    const isBanner = options.type === 'banner' || data?.type === 'banner';
    return {
      isBanner,
      title: (options.title as string) || 'Announcement',
      subtitle: options.subtitle as string,
      description: options.description as string,
      textMessage: options.message as string,
      imageUrl: options.image as string,
      priority: options.priority ? parseInt(String(options.priority)) : 5,
      enabled: options.enabled !== undefined ? options.enabled === 'true' || options.enabled === true : false,
      closeButton:
        options.closeButton !== undefined ? options.closeButton === 'true' || options.closeButton === true : true,
      agreeButton:
        options.agreeButton !== undefined ? options.agreeButton === 'true' || options.agreeButton === true : !isBanner,
      tags: options.tags ? String(options.tags).split(',') : [],
      startDate: (options.startDate as string) || new Date().toISOString().split('T')[0],
      endDate:
        (options.endDate as string) || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      numberOfViews: {
        type: 'standardView',
        value: 0,
        threshold: 3,
        tags: [],
      },
      numberOfAgrees: {
        type: 'standardAgree',
        value: 0,
        threshold: 1,
        tags: [],
      },
    };
  }

  // Parse the natural language query
  const intent = parseModalIntent(cleanQuery);

  // Check for image attachments
  let imageUrl: string | undefined;
  if (attachments) {
    // Look for image files
    const imageAttachment = attachments.find(
      att =>
        att.url?.includes('.png') ||
        att.url?.includes('.jpg') ||
        att.url?.includes('.jpeg') ||
        att.url?.includes('.gif')
    );
    if (imageAttachment) {
      imageUrl = imageAttachment.url;
    }
  }

  // Generate content based on intent
  const content = aiGenerateModalContent({
    ...intent,
    type: (data?.type as 'modal' | 'banner') || intent.type || 'modal',
    intent: cleanQuery,
    images: imageUrl ? [imageUrl] : [],
  });

  // Merge options into modal data (options take priority)
  const enabledValue = options?.enabled !== undefined ? options.enabled === true || options.enabled === 'true' : false;

  const finalModalData: Partial<IModal> = {
    ...content,
    ...(data as Partial<IModal>),
    imageUrl: imageUrl || content.imageUrl || (options?.image as string),
    enabled: enabledValue,
    startDate: (options?.startDate as string) || intent.startDate || new Date().toISOString().split('T')[0],
    endDate:
      (options?.endDate as string) ||
      intent.endDate ||
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    // Handle --type flag for isBanner
    isBanner: options?.type === 'banner' || data?.type === 'banner' || content.isBanner,
  };

  return finalModalData;
}

// Find modal by partial ID (8-24 character hex prefix/suffix matching)
export function findModalByPartialId<T extends { _id?: unknown }>(modals: T[], partialId: string): T | undefined {
  return modals.find(m => {
    if (!m._id) return false;
    const idStr = String(m._id).toLowerCase();
    const searchId = partialId.toLowerCase();
    // Check if ID starts with OR ends with the partial ID
    return idStr.startsWith(searchId) || idStr.endsWith(searchId);
  });
}
