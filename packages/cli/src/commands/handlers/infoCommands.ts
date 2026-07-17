/**
 * Read-only informational commands and the config-editor opener, migrated out
 * of the index.tsx dispatch switch. Each is self-contained: it
 * only touches collaborators exposed on CommandContext, so it runs and tests
 * without any React/Ink involvement.
 */
import { resolveApiEndpoint, getEnvironmentName } from '../../utils';
import type { CommandHandler } from '../types';

const help: CommandHandler = {
  name: 'help',
  run: (_args, ctx) => {
    const customCommands = ctx.customCommandStore.getAllCommands();
    const hasCustomCommands = customCommands.length > 0;

    console.log(`
Available commands:
  /help - Show this help message
  /exit - Exit the CLI
  /clear - Start a new session
  /rewind - Rewind conversation to a previous point
  /undo - Undo the last file change
  /checkpoints - List available file restore points
  /restore <n> - Restore files to a specific checkpoint
  /diff [n] - Show diff between current state and a checkpoint
  /login - Authenticate with your B4M account
  /logout - Clear authentication and sign out
  /whoami - Show current authenticated user
  /usage - Show credit usage and balance
  /save <name> - Save current session
  /resume - List and resume saved sessions
  /config - Show configuration
  /model [id-or-name] - Switch the active model (opens a picker, or matches an argument)

API Configuration:
  /set-api <url> - Connect to self-hosted Bike4Mind instance
  /reset-api - Clear the custom API URL (falls back to the default, or prompts you to pick one)
  /api-info - Show current API configuration

Tool Permissions:
  /trust <tool-name> - Trust a tool (won't ask permission again)
  /untrust <tool-name> - Remove tool from trusted list
  /trusted - List all trusted tools

Project Configuration:
  /project-config - Show merged project configuration

Custom Commands:
  /commands - List all custom commands
  /commands:new <name> - Create a new custom command
  /commands:reload - Reload custom commands from disk

Terminal Setup:
  /terminal-setup - Configure Shift+Enter for multi-line input

Keyboard Shortcuts:
  Ctrl+C          - Press twice to exit
  Esc             - Abort current operation
  Shift+Tab       - Toggle auto-accept edits
  Ctrl+U          - Clear current line
  Ctrl+K          - Clear from cursor to end of line
  Ctrl+W          - Delete word before cursor
  Ctrl+A          - Move cursor to beginning
  Ctrl+E          - Move cursor to end
  Ctrl+B / ←      - Move cursor left
  Ctrl+F / →      - Move cursor right
  Ctrl+D          - Delete character at cursor
  Ctrl+L          - Clear input
  ↑ / ↓           - Navigate history / autocomplete
  Tab             - Accept autocomplete suggestion
  Shift+Cmd+Click - Open links in browser

Multi-line Input:
  \\ + Enter       - Insert newline (works everywhere)
  Option + Enter  - Insert newline (macOS standard terminals)
  Shift + Enter   - Insert newline (iTerm2, WezTerm, Ghostty, Kitty)${hasCustomCommands ? '\n\n📝 Custom Commands Available:' : ''}${
    hasCustomCommands
      ? customCommands
          .map(cmd => {
            const source = cmd.source === 'global' ? '🏠' : '📁';
            const argHint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
            return `\n  ${source} /${cmd.name}${argHint} - ${cmd.description}`;
          })
          .join('')
      : ''
  }
        `);
  },
};

const config: CommandHandler = {
  name: 'config',
  run: (_args, ctx) => {
    // Open interactive configuration editor
    ctx.openConfigEditor();
  },
};

const apiInfo: CommandHandler = {
  name: 'api-info',
  run: async (_args, ctx) => {
    const cfg = await ctx.configStore.get();
    const endpoint = resolveApiEndpoint(cfg.apiConfig);
    const apiType = getEnvironmentName(cfg.apiConfig);

    console.log('\n🌍 API Configuration:\n');
    console.log(`Type: ${apiType}`);
    console.log(`URL: ${endpoint.status === 'configured' ? endpoint.url : '(not configured)'}`);
    console.log('');
  },
};

const trusted: CommandHandler = {
  name: 'trusted',
  run: (_args, ctx) => {
    if (!ctx.permissionManager) {
      console.log('Permission manager not initialized');
      return;
    }
    const trustedTools = ctx.permissionManager.getTrustedTools();
    console.log('\n🔒 Trusted Tools:\n');
    if (trustedTools.length === 0) {
      console.log('  (none)');
    } else {
      trustedTools.forEach(t => console.log(`  - ${t}`));
    }
    console.log('');
  },
};

const dirs: CommandHandler = {
  name: 'dirs',
  run: async (_args, ctx) => {
    const additionalDirs = await ctx.configStore.getAdditionalDirectories();
    const cwd = process.cwd();

    console.log('\n📂 Accessible Directories:\n');
    console.log(`  📁 Working directory: ${cwd}`);

    if (additionalDirs.length > 0) {
      console.log('\n  📁 Additional directories:');
      additionalDirs.forEach(d => {
        console.log(`     ${d}`);
      });
    } else {
      console.log('\n  No additional directories configured.');
      console.log('  Use /add-dir <path> or --add-dir <path> flag to add directories.');
    }

    console.log('');
  },
};

export const infoCommands: CommandHandler[] = [help, config, apiInfo, trusted, dirs];
