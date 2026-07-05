import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Logger } from '@bike4mind/observability';
import { createModal, listModals, updateModal, deleteModal } from '@client/server/tools/modalOperations';

const logger = new Logger({ metadata: { service: 'admin-modal-tool' } });

// Schema for the API request
const requestSchema = z.object({
  query: z.string().describe('Natural language query about modals'),
  context: z
    .object({
      chatHistory: z.array(z.any()).optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
});

/**
 * API endpoint that processes natural language modal requests
 */
const handler = baseApi().post(
  asyncHandler(async (req: any, res: any) => {
    // Silently fail for non-admin users
    if (!req.ability?.can('manage', 'Modal')) {
      logger.info('Modal tool access denied for non-admin user - returning silent failure');
      return res.json({
        success: false,
        message: 'This feature is not available',
        data: null,
      });
    }

    const { query, context } = requestSchema.parse(req.body);
    logger.info(`Modal tool API called with query: "${query}"`);

    try {
      // Parse the natural language query to determine intent and parameters
      const toolParams = await parseNaturalLanguageQuery(query, context);
      logger.info(`Parsed tool params - Action: ${toolParams.action}`, toolParams);

      // Execute the appropriate action based on parsed parameters
      let result;
      switch (toolParams.action) {
        case 'create':
          logger.info('Executing CREATE action');
          result = await createModal(toolParams);
          break;
        case 'list':
          logger.info('Executing LIST action with filter:', toolParams.filter);
          result = await listModals(toolParams.filter);
          break;
        case 'update':
          logger.info(`Executing UPDATE action for modal ${toolParams.modalId}`);
          result = await updateModal(toolParams.modalId, toolParams);
          break;
        case 'delete':
          logger.info(`Executing DELETE action for modal ${toolParams.modalId}`);
          result = await deleteModal(toolParams.modalId);
          break;
        default:
          logger.error(`Unknown action: ${toolParams.action}`);
          result = { success: false, error: 'Unknown action' };
      }

      logger.info(`Modal tool result - Success: ${result.success}, Message: ${result.message}`);
      return res.json(result);
    } catch (error) {
      logger.error('Modal tool error:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process modal request',
      });
    }
  })
);

/**
 * Use LLM to intelligently parse natural language query into tool parameters
 */
export async function parseNaturalLanguageQueryDirect(query: string, context?: any) {
  return parseNaturalLanguageQuery(query, context);
}

async function parseNaturalLanguageQuery(query: string, context?: any) {
  try {
    // Dynamically import OperationsModelService only when needed (server-side only)
    const { OperationsModelService } = await import('@client/services/operationsModelService');
    // Get the operations model for LLM processing
    const { modelId, llm } = await OperationsModelService.getOperationsModel();

    logger.info(`Using LLM model ${modelId} for intent recognition`);

    // Create a structured prompt for the LLM to understand the user's intent
    const systemPrompt = `You are an admin tool intent parser. Analyze the user's query and determine what they want to do with modals/banners.

Available actions:
- create: Create a new modal or banner
- list: List/show existing modals or banners  
- update: Update/edit an existing modal or banner (includes enable/disable, dates, priority, tags)
- delete: Remove a modal or banner

CRITICAL RULES FOR ACTION DETERMINATION:
1. ANY question asking for information MUST use "list" action, NEVER "create"
2. Queries with these patterns MUST use "list" action:
   - "What are all the..."
   - "What banners/modals do we have?"
   - "Show me..."
   - "List all..."
   - "Get all..."
   - "Are there any..."
   - "Tell me about..."
   - "How many..."
   - Any query starting with interrogative words (what, which, where, when, who, how)
3. ONLY use "create" action when explicitly asked to create/make/add something new
4. Questions about existing items ALWAYS use "list", regardless of wording
5. Enable/disable/activate/deactivate commands use "update" action with the modal name/ID
6. Date modification commands (extend, schedule, postpone) use "update" action
7. Priority changes (set priority, mark urgent) use "update" action
8. Tag operations (add tag, remove tag) use "update" action
9. Filtered queries still use "list" action but with filter parameters

Examples:
- "What are all the banners and modals we have?" → action: "list"
- "Show me active banners" → action: "list", filter: {enabled: true, type: "banner"}
- "List modals with priority above 5" → action: "list", filter: {minPriority: 5, type: "modal"}
- "Show banners tagged for new-users" → action: "list", filter: {tags: ["new-users"], type: "banner"}
- "Create a banner saying hello" → action: "create", message: "hello"
- "Create a banner that says wow its cool" → action: "create", message: "wow its cool"
- "Create a modal that announces cleo is pretty" → action: "create", title: "Announcement", description: "cleo is pretty"
- "Make a banner about maintenance" → action: "create", message: "maintenance"
- "Create a modal with the attached image" → action: "create", useAttachedImage: true
- "Use the image to create a banner" → action: "create", useAttachedImage: true
- "Enable the D20 modal" → action: "update", enabled: true
- "Extend welcome modal until December 31" → action: "update", endDate: "2024-12-31"
- "Schedule maintenance banner for next week" → action: "update", startDate: calculated date
- "Set holiday modal priority to 8" → action: "update", priority: 8
- "Mark urgent banner as priority 10" → action: "update", priority: 10
- "Add tag power-users to the D20 modal" → action: "update", addTags: ["power-users"]
- "Remove tag beta from welcome banner" → action: "update", removeTags: ["beta"]
- "Tag modal for new-feature" → action: "update", addTags: ["new-feature"]

For CREATE actions:
- Extract the message/description from the query
- Patterns like "that says X", "saying X", "about X", "announces X" → message: "X"
- For banners: put the text in "message" field (required for banners)
- For modals: put the text in "description" field
- Always extract the actual text, don't use defaults like "Important update"

For UPDATE/DELETE actions:
- Extract the modal/banner identifier from the query (name, title, or ID)
- Put the identifier in both "modalId" and "title" fields
- For enable/disable, set "enabled" to true/false accordingly
- For date changes, set "startDate" and/or "endDate" in ISO format (YYYY-MM-DD)
- For priority changes, set "priority" (0-10, where 10 is highest)
- For tag operations, use "addTags" or "removeTags" arrays

For LIST actions with filters:
- Set filter.enabled for active/inactive filtering
- Set filter.type for "modal" or "banner" filtering
- Set filter.tags array for tag filtering
- Set filter.minPriority/maxPriority for priority range filtering
- Set filter.dateRange for date filtering (activeOn, startBefore, endAfter)

Date parsing hints:
- "next week" = 7 days from today
- "tomorrow" = 1 day from today
- "end of month" = last day of current month
- "December 31" or "12/31" = specific date in current or next year
- "extend by X days" = add X days to current endDate

IMPORTANT: Return ONLY valid JSON with no markdown formatting or extra text.
Keep the response concise - omit null fields:
{
  "action": "<action>",
  "entityType": "<modal|banner|both>",
  "parameters": {
    "title": "<title if creating/updating>",
    "message": "<text for banners - extract from 'says X', 'about X', etc>",
    "description": "<description for modals>",
    "enabled": <true|false if setting>,
    "priority": <number if setting>,
    "filter": <filter object if listing>,
    "modalId": "<id if updating/deleting>",
    "startDate": "<date if setting>",
    "endDate": "<date if setting>",
    "addTags": ["<tags>"],
    "removeTags": ["<tags>"],
    "useAttachedImage": <true if user mentions using attached/provided image>
  }
}`;

    const userPrompt = `User query: "${query}"

Context: User is an admin managing system modals and banners.
${context?.chatHistory?.length ? `Recent chat history available: ${context.chatHistory.length} messages` : 'No chat history available'}

What is the user's intent?`;

    let llmResponse = '';
    await llm.complete(
      modelId,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        maxTokens: 4000, // Large budget for lengthy descriptions and complete JSON
        temperature: 0.1, // Low temperature for more deterministic parsing
      },
      async (chunks: (string | null | undefined)[]) => {
        llmResponse += chunks.filter(Boolean).join('');
      }
    );

    logger.info(`LLM raw response length: ${llmResponse.length} characters`);
    logger.debug(`LLM raw response: ${llmResponse.substring(0, 500)}...`);

    // Parse the LLM response
    try {
      // Extract JSON from the response (in case LLM adds extra text)
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('No JSON found in LLM response');
        logger.warn(`Raw response first 300 chars: ${llmResponse.substring(0, 300)}`);
        throw new Error('No JSON found in LLM response');
      }

      // Clean up the JSON string before parsing
      let jsonString = jsonMatch[0];

      // Log the extracted JSON before cleaning (don't add ellipsis in log!)
      logger.debug(`Extracted JSON before cleaning (first 500 chars): ${jsonString.substring(0, 500)}`);
      logger.debug(`Full extracted JSON length: ${jsonString.length} chars`);

      // First, check if JSON contains ellipsis anywhere (not just at end)
      if (jsonString.includes('...')) {
        logger.warn('JSON contains ellipsis, attempting to fix');

        // Find where the ellipsis occurs
        const ellipsisIndex = jsonString.indexOf('...');

        // Truncate at the ellipsis and clean up
        jsonString = jsonString.substring(0, ellipsisIndex);

        // Remove any trailing comma or incomplete key-value pair
        jsonString = jsonString.replace(/,\s*$/, ''); // Remove trailing comma
        jsonString = jsonString.replace(/,\s*"[^"]*":\s*$/, ''); // Remove incomplete key-value
        jsonString = jsonString.replace(/,\s*"[^"]*":$/, ''); // Remove key without value
      }

      // Check if JSON appears truncated (doesn't have proper closing)
      if (!jsonString.trim().endsWith('}')) {
        logger.warn('JSON appears truncated, adding closing braces');

        // Try to close any open structures
        const openBraces = (jsonString.match(/\{/g) || []).length;
        const closeBraces = (jsonString.match(/\}/g) || []).length;

        // Add missing closing braces
        for (let i = 0; i < openBraces - closeBraces; i++) {
          jsonString += '}';
        }
      }

      // Remove any trailing commas before closing braces/brackets
      jsonString = jsonString.replace(/,(\s*[}\]])/g, '$1');

      // Fix common JSON issues
      // Replace single quotes with double quotes (but not in string values)
      jsonString = jsonString.replace(/'/g, '"');

      // Remove control characters
      // eslint-disable-next-line no-control-regex
      jsonString = jsonString.replace(/[\x00-\x1F\x7F]/g, ' ');

      // Remove any newlines within string values
      jsonString = jsonString.replace(/"([^"]*)\n([^"]*)"/g, '"$1 $2"');

      // Fix incomplete key-value pairs at the end (e.g., "removeTags": null,)
      jsonString = jsonString.replace(/,\s*$/, '');

      logger.info(`Cleaned JSON (first 500 chars): ${jsonString.substring(0, 500)}`);
      logger.info(`Cleaned JSON length: ${jsonString.length} characters`);

      // Log if JSON still contains ellipsis after cleaning
      if (jsonString.includes('...')) {
        logger.error('WARNING: JSON still contains ellipsis after cleaning!');
        const ellipsisPos = jsonString.indexOf('...');
        logger.error(
          `Ellipsis found at position ${ellipsisPos}: ${jsonString.substring(Math.max(0, ellipsisPos - 20), ellipsisPos + 20)}`
        );
      }

      const intent = JSON.parse(jsonString);

      // Build parameters based on the LLM's intent recognition
      const params: any = {
        action: intent.action || 'list', // Default to list if unclear
      };

      // Map the LLM intent to our parameter structure
      if (intent.action === 'create') {
        params.type = intent.entityType === 'banner' ? 'banner' : 'modal';
        params.title = intent.parameters?.title || `New ${params.type === 'banner' ? 'Banner' : 'Modal'}`;
        params.message = intent.parameters?.message || '';
        params.description = intent.parameters?.description || intent.parameters?.message || '';
        params.enabled = intent.parameters?.enabled ?? false; // Safe default
        params.priority = intent.parameters?.priority || 5;
        params.tags = intent.parameters?.tags || [];
        params.fromContext = intent.parameters?.fromContext || false;
        if (params.fromContext) {
          params.chatHistory = context?.chatHistory;
        }

        // Check for attached image usage
        if (intent.parameters?.useAttachedImage && context?.attachments) {
          const imageAttachment = context.attachments.find((att: any) => att.type === 'image');
          if (imageAttachment?.url) {
            params.imageUrl = imageAttachment.url;
            logger.info(`Using attached image URL: ${params.imageUrl}`);
          }
        }

        // Add logging to debug what we're getting
        logger.info(
          `LLM CREATE params - title: "${params.title}", description: "${params.description}", message: "${params.message}", imageUrl: "${params.imageUrl || 'none'}"`
        );
      } else if (intent.action === 'list') {
        params.filter = intent.parameters?.filter || {};

        // Apply entity type filter
        if (intent.entityType === 'modal') {
          params.filter.type = 'modal';
        } else if (intent.entityType === 'banner') {
          params.filter.type = 'banner';
        }
        // 'both' means no type filter

        // Apply enabled filter if specified
        if (intent.parameters?.enabled !== undefined) {
          params.filter.enabled = intent.parameters.enabled;
        }

        // Apply advanced filters from LLM parsing
        if (intent.parameters?.filter?.minPriority !== undefined) {
          params.filter.minPriority = intent.parameters.filter.minPriority;
        }
        if (intent.parameters?.filter?.maxPriority !== undefined) {
          params.filter.maxPriority = intent.parameters.filter.maxPriority;
        }
        if (intent.parameters?.filter?.tags && intent.parameters.filter.tags.length > 0) {
          params.filter.tags = intent.parameters.filter.tags;
        }
        if (intent.parameters?.filter?.dateRange) {
          params.filter.dateRange = intent.parameters.filter.dateRange;
        }
      } else if (intent.action === 'update' || intent.action === 'delete') {
        params.modalId = intent.parameters?.modalId;
        params.title = intent.parameters?.title; // Use title to help find the modal

        if (intent.action === 'update') {
          // Copy over update parameters
          if (intent.parameters?.enabled !== undefined) {
            params.enabled = intent.parameters.enabled;
          }
          if (intent.parameters?.message !== undefined) {
            params.message = intent.parameters.message;
          }
          if (intent.parameters?.description !== undefined) {
            params.description = intent.parameters.description;
          }
          if (intent.parameters?.priority !== undefined) {
            params.priority = intent.parameters.priority;
          }
          if (intent.parameters?.tags !== undefined) {
            params.tags = intent.parameters.tags;
          }
          // Handle date parameters
          if (intent.parameters?.startDate !== undefined) {
            params.startDate = intent.parameters.startDate;
          }
          if (intent.parameters?.endDate !== undefined) {
            params.endDate = intent.parameters.endDate;
          }
          // Handle tag operations
          if (intent.parameters?.addTags && intent.parameters.addTags.length > 0) {
            params.addTags = intent.parameters.addTags;
          }
          if (intent.parameters?.removeTags && intent.parameters.removeTags.length > 0) {
            params.removeTags = intent.parameters.removeTags;
          }
        }
      }

      logger.info(`Parsed intent - Action: ${params.action}, Type: ${params.type || 'N/A'}`);

      return params;
    } catch (parseError) {
      logger.error('Failed to parse LLM response as JSON:', parseError);
      logger.warn('Falling back to simple pattern matching');

      // Fallback to simple pattern matching if LLM fails
      return fallbackParsing(query, context);
    }
  } catch (error) {
    logger.error('Error in LLM intent recognition:', error);
    // Fallback to simple pattern matching
    return fallbackParsing(query, context);
  }
}

/**
 * Fallback parsing using simple pattern matching
 */
function fallbackParsing(query: string, context?: any) {
  const lower = query.toLowerCase();

  logger.info(`Fallback parsing for query: "${query}"`);

  // Check if this is a question (starts with interrogative or contains question patterns)
  const questionWords = ['what', 'which', 'where', 'when', 'who', 'how', 'are', 'is', 'do', 'does', 'can'];
  const firstWord = lower.split(/\s+/)[0];
  const isQuestion = questionWords.includes(firstWord) || query.includes('?');

  // Questions about existing modals/banners - be very aggressive about detecting these
  if (
    isQuestion ||
    lower.includes('what') ||
    lower.includes('show') ||
    lower.includes('list') ||
    lower.includes('get') ||
    lower.includes('have') ||
    lower.includes('are there') ||
    lower.includes('all the') ||
    lower.includes('tell me') ||
    lower.includes('how many') ||
    (lower.includes('we have') && !lower.includes('create'))
  ) {
    logger.info('Detected as LIST action (question/query)');
    const params: any = {
      action: 'list',
      filter: {},
    };

    if (lower.includes('banner') && !lower.includes('modal')) {
      params.filter.type = 'banner';
    } else if (lower.includes('modal') && !lower.includes('banner')) {
      params.filter.type = 'modal';
    }

    if (lower.includes('enabled') || lower.includes('active')) {
      params.filter.enabled = true;
    } else if (lower.includes('disabled') || lower.includes('inactive')) {
      params.filter.enabled = false;
    }

    // Check for priority filters
    const priorityMatch = query.match(/priority\s+(?:above|over|greater\s+than|>)\s+(\d+)/i);
    if (priorityMatch) {
      params.filter.minPriority = parseInt(priorityMatch[1]);
    }
    const maxPriorityMatch = query.match(/priority\s+(?:below|under|less\s+than|<)\s+(\d+)/i);
    if (maxPriorityMatch) {
      params.filter.maxPriority = parseInt(maxPriorityMatch[1]);
    }

    // Check for tag filters
    const tagMatch = query.match(/tagged?\s+(?:for\s+|with\s+)?["']?([^"']+?)["']?(?:\s+and|\s+or|$)/i);
    if (tagMatch) {
      params.filter.tags = [tagMatch[1].trim()];
    }

    return params;
  }

  // Check for priority update commands
  if (lower.includes('priority') && (lower.includes('set') || lower.includes('mark') || lower.includes('change'))) {
    logger.info('Detected as UPDATE action (priority change)');

    // Extract modal identifier and priority
    let modalIdentifier = '';
    let priority = null;

    // Extract priority value
    const priorityMatch = query.match(/priority\s+(?:to\s+)?(\d+)/i);
    if (priorityMatch) {
      priority = parseInt(priorityMatch[1]);
    }

    // Check for "urgent" or "high priority" keywords
    if (lower.includes('urgent') || lower.includes('high priority')) {
      priority = 10;
    } else if (lower.includes('low priority')) {
      priority = 2;
    }

    // Extract modal name
    const namePatterns = [
      /(?:set|mark|change)\s+(?:the\s+)?["']?([^"']+?)["']?\s+(?:priority|as)/i,
      /(?:modal|banner)\s+(?:named|called)?\s*["']?([^"']+?)["']?/i,
    ];

    for (const pattern of namePatterns) {
      const match = query.match(pattern);
      if (match && match[1]) {
        modalIdentifier = match[1].trim();
        break;
      }
    }

    return {
      action: 'update',
      modalId: modalIdentifier,
      title: modalIdentifier,
      priority: priority,
    };
  }

  // Check for date update commands
  if (
    lower.includes('extend') ||
    lower.includes('schedule') ||
    lower.includes('postpone') ||
    (lower.includes('set') && (lower.includes('date') || lower.includes('until')))
  ) {
    logger.info('Detected as UPDATE action (date change)');

    let modalIdentifier = '';
    let startDate = null;
    let endDate = null;

    // Parse relative dates
    const today = new Date();
    if (lower.includes('tomorrow')) {
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (lower.includes('until')) {
        endDate = tomorrow.toISOString().split('T')[0];
      } else {
        startDate = tomorrow.toISOString().split('T')[0];
      }
    } else if (lower.includes('next week')) {
      const nextWeek = new Date(today);
      nextWeek.setDate(nextWeek.getDate() + 7);
      if (lower.includes('until') || lower.includes('extend')) {
        endDate = nextWeek.toISOString().split('T')[0];
      } else {
        startDate = nextWeek.toISOString().split('T')[0];
      }
    }

    // Parse specific dates
    const dateMatch = query.match(/(?:until|to|for)\s+(\w+\s+\d{1,2}|\d{1,2}\/\d{1,2})/i);
    if (dateMatch) {
      // Simple date parsing - would need more robust handling in production
      const dateStr = dateMatch[1];
      // For now, assume current year
      endDate = `${new Date().getFullYear()}-${dateStr}`;
    }

    // Extract modal name
    const namePatterns = [
      /(?:extend|schedule|postpone|set)\s+(?:the\s+)?["']?([^"']+?)["']?\s+(?:until|for|to)/i,
      /(?:modal|banner)\s+(?:named|called)?\s*["']?([^"']+?)["']?/i,
    ];

    for (const pattern of namePatterns) {
      const match = query.match(pattern);
      if (match && match[1]) {
        modalIdentifier = match[1].trim();
        break;
      }
    }

    return {
      action: 'update',
      modalId: modalIdentifier,
      title: modalIdentifier,
      startDate: startDate,
      endDate: endDate,
    };
  }

  // Check for tag operations
  if ((lower.includes('add') || lower.includes('remove')) && lower.includes('tag')) {
    logger.info('Detected as UPDATE action (tag operation)');

    let modalIdentifier = '';
    let addTags: string[] = [];
    let removeTags: string[] = [];

    // Extract tag name
    const tagMatch = query.match(/tag\s+["']?([^"']+?)["']?\s+(?:to|from)/i);
    const tagName = tagMatch ? tagMatch[1].trim() : '';

    if (lower.includes('add')) {
      addTags = [tagName];
    } else if (lower.includes('remove')) {
      removeTags = [tagName];
    }

    // Extract modal name
    const namePatterns = [
      /(?:to|from)\s+(?:the\s+)?["']?([^"']+?)["']?(?:\s+modal|\s+banner|$)/i,
      /(?:modal|banner)\s+(?:named|called)?\s*["']?([^"']+?)["']?/i,
    ];

    for (const pattern of namePatterns) {
      const match = query.match(pattern);
      if (match && match[1]) {
        modalIdentifier = match[1].trim();
        break;
      }
    }

    return {
      action: 'update',
      modalId: modalIdentifier,
      title: modalIdentifier,
      addTags: addTags.length > 0 ? addTags : undefined,
      removeTags: removeTags.length > 0 ? removeTags : undefined,
    };
  }

  // Check for enable/disable/update commands
  const updateWords = [
    'enable',
    'disable',
    'activate',
    'deactivate',
    'turn on',
    'turn off',
    'update',
    'edit',
    'change',
    'modify',
  ];
  const hasUpdateCommand = updateWords.some(word => lower.includes(word));

  if (hasUpdateCommand) {
    logger.info('Detected as UPDATE action (enable/disable/modify)');

    // Extract modal identifier from the query
    let modalIdentifier = '';

    // Try to extract text after "the" or quoted text
    const patterns = [
      /(?:enable|disable|activate|deactivate|turn on|turn off|update|edit)\s+(?:the\s+)?["']?([^"']+?)["']?(?:\s+modal|\s+banner|$)/i,
      /(?:modal|banner)\s+(?:named|called|titled|id)?\s*["']?([^"']+?)["']?/i,
    ];

    for (const pattern of patterns) {
      const match = query.match(pattern);
      if (match && match[1]) {
        modalIdentifier = match[1].trim();
        break;
      }
    }

    // Determine if enabling or disabling
    const isEnabling = lower.includes('enable') || lower.includes('activate') || lower.includes('turn on');
    const isDisabling = lower.includes('disable') || lower.includes('deactivate') || lower.includes('turn off');

    return {
      action: 'update',
      modalId: modalIdentifier, // This will need to be resolved to actual ID
      title: modalIdentifier, // Pass the identifier to help find the modal
      enabled: isEnabling ? true : isDisabling ? false : undefined,
    };
  }

  // Check for explicit create/make/add commands
  const createWords = ['create', 'make', 'add', 'build', 'generate'];
  const hasCreateCommand = createWords.some(word => lower.includes(word));

  if (!hasCreateCommand) {
    // If no explicit create or update command and not a question, still default to list for safety
    logger.info('No explicit command found, defaulting to LIST action');
    return {
      action: 'list',
      filter: {},
    };
  }

  // Only get here if there's an explicit create command
  logger.info('Detected as CREATE action (explicit command)');
  const type = lower.includes('banner') ? 'banner' : 'modal';
  let message = '';
  let title = '';
  let description = '';

  // First check for explicit title patterns
  const titlePatterns = [
    /titled?\s+["']([^"']+)["']/i,
    /called?\s+["']([^"']+)["']/i,
    /named?\s+["']([^"']+)["']/i,
    /title:\s*["']([^"']+)["']/i,
  ];

  for (const pattern of titlePatterns) {
    const match = query.match(pattern);
    if (match && match[1]) {
      title = match[1].trim();
      logger.info(`Extracted title from pattern: "${title}"`);
      break;
    }
  }

  // Check for description or message after "and"
  const descPatterns = [
    /and\s+["']([^"']+)["']/i,
    /with\s+(?:message|description)\s+["']([^"']+)["']/i,
    /that says\s+(.+)/i,
    /saying\s+(.+)/i,
    /with message\s+(.+)/i,
    /message:\s*(.+)/i,
  ];

  for (const pattern of descPatterns) {
    const match = query.match(pattern);
    if (match && match[1]) {
      description = match[1].trim();
      if (!message) message = description;
      if (!title) title = description; // Use description as title if no title found
      logger.info(`Extracted description from pattern: "${description}"`);
      break;
    }
  }

  // Check for image attachment references
  let useAttachedImage = false;
  const imagePatterns = [
    /attached\s+image/i,
    /use\s+the\s+image/i,
    /with\s+the\s+image/i,
    /image\s+attached/i,
    /provided\s+image/i,
  ];

  for (const pattern of imagePatterns) {
    if (pattern.test(query)) {
      useAttachedImage = true;
      logger.info('Detected request to use attached image');
      break;
    }
  }

  const result: any = {
    action: 'create',
    type,
    title: title || `New ${type === 'banner' ? 'Banner' : 'Modal'}`,
    message: message || description,
    description: description || message || '',
    enabled: false,
    priority: 5,
    tags: [],
  };

  // If user requested to use attached image, extract it from context
  if (useAttachedImage && context?.attachments) {
    const imageAttachment = context.attachments.find((att: any) => att.type === 'image');
    if (imageAttachment?.url) {
      result.imageUrl = imageAttachment.url;
      logger.info(`Using attached image URL in fallback: ${result.imageUrl}`);
    }
  }

  logger.info('Fallback parsing result for CREATE:', result);
  return result;
}

export default handler;

// Re-export functions for direct server-side use
export { createModal, listModals, updateModal, deleteModal };
