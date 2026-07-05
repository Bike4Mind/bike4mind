import {
  IUserDocument,
  AdminTool,
  AdminToolContext,
  AdminToolParams,
  AdminToolResult,
  AdminToolRegistry,
  AdminActionLog,
} from '@bike4mind/common';

export class AdminToolService implements AdminToolRegistry {
  private static instance: AdminToolService;
  public tools: Map<string, AdminTool>;

  private constructor() {
    this.tools = new Map();
    this.registerBuiltInTools();
  }

  public static getInstance(): AdminToolService {
    if (!AdminToolService.instance) {
      AdminToolService.instance = new AdminToolService();
    }
    return AdminToolService.instance;
  }

  // Register a new admin tool
  public register(tool: AdminTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`Admin tool ${tool.name} is already registered. Overwriting.`);
    }
    this.tools.set(tool.name, tool);
  }

  // Get a specific tool
  public get(name: string): AdminTool | undefined {
    return this.tools.get(name);
  }

  // List all tools accessible to a user
  public list(user: IUserDocument): AdminTool[] {
    const accessibleTools: AdminTool[] = [];

    this.tools.forEach(tool => {
      if (this.canAccess(user, tool.name)) {
        accessibleTools.push(tool);
      }
    });

    return accessibleTools;
  }

  // Check if user can access a specific tool
  public canAccess(user: IUserDocument, toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;

    // Check admin requirement
    if (tool.requiresAdmin && !user.isAdmin) {
      return false;
    }

    return true;
  }

  // Execute an admin tool
  public async execute(toolName: string, context: AdminToolContext, params: AdminToolParams): Promise<AdminToolResult> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      return {
        success: false,
        error: `Admin tool ${toolName} not found. Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
      };
    }

    // Double-check permissions
    if (!this.canAccess(context.user, toolName)) {
      await this.logAction({
        userId: context.user.id || '',
        action: 'execute',
        tool: toolName,
        params,
        result: 'failure',
        error: 'Permission denied',
        timestamp: new Date(),
      });

      return {
        success: false,
        error: 'You do not have permission to use this admin tool',
      };
    }

    try {
      // Execute the tool handler
      const result = await tool.handler(context, params);

      // Log successful execution
      await this.logAction({
        userId: context.user.id || '',
        action: params.action || 'execute',
        tool: toolName,
        params,
        result: 'success',
        timestamp: new Date(),
        metadata: result.data,
      });

      return result;
    } catch (error) {
      console.error(`Error executing admin tool ${toolName}:`, error);

      // Log failed execution
      await this.logAction({
        userId: context.user.id || '',
        action: params.action || 'execute',
        tool: toolName,
        params,
        result: 'failure',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date(),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'An error occurred executing the admin tool',
      };
    }
  }

  // Parse natural language command
  public parseCommand(input: string): { tool: string; params: AdminToolParams } | null {
    const lowerInput = input.toLowerCase().trim();

    // Check for direct tool commands
    for (const [name, tool] of Array.from(this.tools)) {
      if (lowerInput.startsWith(tool.command)) {
        const paramString = input.substring(tool.command.length).trim();
        return {
          tool: name,
          params: this.parseParams(paramString),
        };
      }
    }

    // Check for natural language patterns
    if (lowerInput.includes('create') && (lowerInput.includes('modal') || lowerInput.includes('banner'))) {
      return {
        tool: 'modal', // must match the registered tool name
        params: {
          action: 'create',
          query: input,
          data: {
            type: lowerInput.includes('banner') ? 'banner' : 'modal',
            fromContext:
              lowerInput.includes('context') || lowerInput.includes('above') || lowerInput.includes('conversation'),
          },
        },
      };
    }

    if (lowerInput.includes('add') && lowerInput.includes('credit')) {
      return {
        tool: 'credit_management',
        params: {
          action: 'add',
          query: input,
        },
      };
    }

    return null;
  }

  // Parse command parameters
  private parseParams(paramString: string): AdminToolParams {
    const params: AdminToolParams = {
      options: {},
    };

    // Parse action (first word)
    const words = paramString.split(' ');
    if (words.length > 0) {
      params.action = words[0];
    }

    // Parse flags and options (--flag value)
    // Handles: --flag "quoted value", --flag 'quoted value', or --flag unquoted multi-word value
    // Split by -- first, then parse each flag
    const flagParts = paramString.split(/\s+--/).filter(Boolean);

    for (const part of flagParts) {
      // Match: flagName value (value can be quoted or unquoted)
      const match = part.match(/^(\w+)\s+(.+)$/);
      if (match) {
        const flag = match[1];
        let value = match[2].trim();

        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }

        params.options![flag] = value;
      } else {
        // Flag without value (just the flag name)
        const flagMatch = part.match(/^(\w+)$/);
        if (flagMatch) {
          params.options![flagMatch[1]] = true;
        }
      }
    }

    // Store the full query for natural language processing
    params.query = paramString;

    return params;
  }

  // Log admin actions for audit trail
  private async logAction(log: AdminActionLog): Promise<void> {
    try {
      // Not yet persisted to a database; logs to console for now.
      console.log('[ADMIN ACTION]', JSON.stringify(log, null, 2));

      // TODO: Implement database logging
      // await AdminActionLogModel.create(log);
    } catch (error) {
      console.error('Failed to log admin action:', error);
    }
  }

  // Register built-in admin tools
  private registerBuiltInTools(): void {
    // Register help tool
    this.register({
      name: 'help',
      description: 'Show help for admin tools',
      command: '/admin help',
      requiredPermissions: [],
      requiresAdmin: true,
      handler: async () => ({
        success: true,
        type: 'help',
        data: this.getHelpText({ isAdmin: true, tags: ['Admin'] } as any),
      }),
    });

    // Modal management tool will be registered from index.ts
    console.log('Admin Tool Service initialized with built-in tools');
  }

  // Helper method to format help text
  public getHelpText(user: IUserDocument): string {
    const tools = this.list(user);

    if (tools.length === 0) {
      return 'No admin tools available for your account.';
    }

    let helpText = '🔧 **Admin Tools Help**\n\n';

    helpText += '## Available Commands:\n\n';
    helpText += '### Basic Commands\n';
    helpText += '- `/admin` or `/admin help` - Show this help message\n';
    helpText += '- `/admin modal create` - Create a new modal\n';
    helpText += '- `/admin modal from-context` - Create a modal from recent chat history\n';
    helpText += '- `/admin modal list` - List all modals\n';
    helpText += '- `/admin modal trigger <id or title>` - Show/trigger a modal\n';
    helpText += '- `/admin modal delete <id>` - Delete a modal\n';
    helpText += '- `/admin modal edit <id>` - Edit an existing modal\n\n';

    helpText += '### Natural Language Commands\n';
    helpText += 'You can also use natural language:\n';
    helpText += '- "Create a modal for the new feature announcement"\n';
    helpText += '- "Make a banner about maintenance"\n';
    helpText += '- "Show me all active modals"\n';
    helpText += '- "Trigger modal California" or "Show banner welcome"\n';
    helpText += '- "Create a modal from the conversation above"\n\n';

    helpText += '## Available Flags:\n\n';
    helpText += '### Basic Properties\n';
    helpText += '- `--type <modal|banner>` - Type of notification\n';
    helpText += '- `--title <text>` - Title of the modal\n';
    helpText += '- `--subtitle <text>` - Subtitle (modals only)\n';
    helpText += '- `--description <text>` - Description/body content\n';
    helpText += '- `--message <text>` - Text message (for banners)\n\n';

    helpText += '### Display Options\n';
    helpText += '- `--enabled <true|false>` - Enable/disable immediately (default: false)\n';
    helpText += '- `--priority <0-10>` - Priority level (default: 5, 10 is highest)\n';
    helpText += '- `--closeButton <true|false>` - Show close button (default: true)\n';
    helpText += '- `--agreeButton <true|false>` - Show agree button (default: true for modals, false for banners)\n\n';

    helpText += '### Targeting\n';
    helpText += '- `--tags <tag1,tag2>` - Comma-separated user tags (e.g., new-user,premium)\n\n';

    helpText += '### Scheduling\n';
    helpText += '- `--startDate <YYYY-MM-DD>` - When to start showing (default: today)\n';
    helpText += '- `--endDate <YYYY-MM-DD>` - When to stop showing (default: 7 days from now)\n\n';

    helpText += '### Media\n';
    helpText += '- `--image <url>` - Image URL to display\n\n';

    helpText += '## Examples:\n\n';
    helpText += '### Simple Commands\n';
    helpText += '```\n';
    helpText += '/admin modal create --type banner --title "Hello World"\n';
    helpText += '/admin modal create --type modal --title "Welcome" --description "Get started!"\n';
    helpText += '/admin modal from-context --type banner\n';
    helpText += '```\n\n';

    helpText += '### Full Configuration\n';
    helpText += '```\n';
    helpText +=
      '/admin modal create --type modal --title "Welcome" --subtitle "Get Started" --description "Welcome to our platform!" --priority 8 --enabled true --tags new-user,beta-tester\n';
    helpText += '```\n\n';

    helpText += '### Scheduled Banner\n';
    helpText += '```\n';
    helpText +=
      '/admin modal create --type banner --message "Maintenance tonight" --startDate 2025-10-22 --endDate 2025-10-23 --priority 10\n';
    helpText += '```\n\n';

    helpText += '### With Image\n';
    helpText += '```\n';
    helpText +=
      '/admin modal create --type modal --title "New Feature" --description "Check this out!" --image https://example.com/image.png\n';
    helpText += '```\n\n';

    helpText += '## Notes:\n\n';
    helpText += '- **Quotes**: Only needed if the value contains spaces\n';
    helpText += '  - OK: `--title Hi`\n';
    helpText += '  - Needed: `--title "Hello World"`\n';
    helpText += '- **Boolean values**: Can be `true` or `false`\n';
    helpText += '- **Comma-separated**: For `--tags`, use commas with no spaces: `tag1,tag2,tag3`\n';
    helpText += '- **Dates**: Must be in `YYYY-MM-DD` format\n';
    helpText += '- **Default behavior**: All modals are created disabled by default for safety\n';
    helpText +=
      '- **Natural language**: Mix flags with natural language: `create welcome message --title "Custom Title"`\n';
    helpText += '- **All actions are logged for security**\n';

    return helpText;
  }
}
