/**
 * External MCP commands (b4m mcp list, b4m mcp add, etc.)
 * These run outside the interactive CLI session
 */

import { ConfigStore } from '../storage/ConfigStore.js';
import type { CliConfig } from '../storage/types.js';

interface McpCommandArgs {
  _: (string | number)[];
  name?: string;
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

/**
 * Main handler for MCP subcommands
 */
export async function handleMcpCommand(subcommand: string, argv: McpCommandArgs): Promise<void> {
  const configStore = new ConfigStore();
  const config = await configStore.load();

  switch (subcommand) {
    case 'list':
      await handleList(config);
      break;

    case 'add': {
      if (!argv.name) {
        console.error('❌ Usage: b4m mcp add <name> -- <command> [args...]');
        console.error('');
        console.error('The -- separator is required to separate the server name from the command.');
        console.error('');
        console.error('Examples:');
        console.error('  b4m mcp add context7 -- npx -y @upstash/context7-mcp');
        console.error('  b4m mcp add github -- docker run -i ghcr.io/modelcontextprotocol/servers/github');
        process.exit(1);
      }

      // Parse the -- separator manually: yargs doesn't handle variadic args after --.
      // Everything after -- is the MCP server command and its args.
      const dashDashIndex = process.argv.indexOf('--');

      if (dashDashIndex === -1) {
        console.error('❌ Missing -- separator');
        console.error('');
        console.error('Usage: b4m mcp add <name> -- <command> [args...]');
        console.error('');
        console.error('The -- separator is required to separate the server name from the command.');
        process.exit(1);
      }

      const commandParts = process.argv.slice(dashDashIndex + 1);

      if (commandParts.length === 0) {
        console.error('❌ No command specified after --');
        console.error('');
        console.error('Usage: b4m mcp add <name> -- <command> [args...]');
        process.exit(1);
      }

      const command = commandParts[0];
      const args = commandParts.slice(1);

      await handleAdd(config, argv.name, command, args, configStore);
      break;
    }

    case 'remove':
      if (!argv.name) {
        console.error('❌ Usage: b4m mcp remove <name>');
        process.exit(1);
      }
      await handleRemove(config, argv.name, configStore);
      break;

    case 'enable':
      if (!argv.name) {
        console.error('❌ Usage: b4m mcp enable <name>');
        process.exit(1);
      }
      await handleEnable(config, argv.name, configStore);
      break;

    case 'disable':
      if (!argv.name) {
        console.error('❌ Usage: b4m mcp disable <name>');
        process.exit(1);
      }
      await handleDisable(config, argv.name, configStore);
      break;

    default:
      console.error(`❌ Unknown MCP subcommand: ${subcommand}`);
      console.error('');
      console.error('Available commands:');
      console.error('  b4m mcp list                      - List configured MCP servers');
      console.error('  b4m mcp add <name> -- <command>   - Add a new MCP server');
      console.error('  b4m mcp remove <name>             - Remove an MCP server');
      console.error('  b4m mcp enable <name>             - Enable an MCP server');
      console.error('  b4m mcp disable <name>            - Disable an MCP server');
      process.exit(1);
  }
}

/**
 * List configured MCP servers
 */
async function handleList(config: CliConfig): Promise<void> {
  if (config.mcpServers.length === 0) {
    console.log('📡 No MCP servers configured.');
    console.log('');
    console.log('To add an MCP server:');
    console.log('  b4m mcp add <name> -- <command> [args...]');
    console.log('');
    console.log('Examples:');
    console.log('  b4m mcp add context7 -- npx -y @upstash/context7-mcp');
    console.log('  b4m mcp add github -- docker run -i ghcr.io/modelcontextprotocol/servers/github');
    return;
  }

  console.log('📡 Configured MCP Servers:\n');

  for (const server of config.mcpServers) {
    const status = server.enabled ? '✅ Enabled' : '⏸️  Disabled';
    const commandInfo = server.command ? `${server.command} ${(server.args || []).join(' ')}` : '(internal)';

    console.log(`• ${server.name} - ${status}`);
    console.log(`  Command: ${commandInfo}`);

    if (Object.keys(server.env).length > 0) {
      const envKeys = Object.keys(server.env).join(', ');
      console.log(`  Env vars: ${envKeys}`);
    }
    console.log('');
  }

  console.log('To manage servers:');
  console.log('  b4m mcp add <name> -- <command> [args...]  - Add server');
  console.log('  b4m mcp remove <name>                      - Remove server');
  console.log('  b4m mcp enable <name>                      - Enable server');
  console.log('  b4m mcp disable <name>                     - Disable server');
}

/**
 * Add a new MCP server
 */
async function handleAdd(
  config: CliConfig,
  name: string,
  command: string,
  args: string[],
  configStore: ConfigStore
): Promise<void> {
  // Check if server already exists
  const existing = config.mcpServers.find(s => s.name === name);
  if (existing) {
    console.error(`❌ MCP server "${name}" already exists.`);
    console.error('   Use "b4m mcp remove" first to replace it.');
    process.exit(1);
  }

  // Validate name (alphanumeric, dash, underscore only)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    console.error('❌ Server name must contain only alphanumeric characters, dashes, and underscores.');
    process.exit(1);
  }

  // Add new server
  const newServer = {
    name,
    command,
    args,
    env: {},
    enabled: true,
  };

  config.mcpServers.push(newServer);

  try {
    await configStore.save(config);
    console.log(`✅ Added MCP server "${name}"`);
    console.log('');
    console.log('Configuration saved to: ~/.bike4mind/config.json');
    console.log('');
    console.log('The server will be available next time you start the CLI.');
  } catch (error) {
    console.error(`❌ Failed to save configuration:`, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Remove an MCP server
 */
async function handleRemove(config: CliConfig, name: string, configStore: ConfigStore): Promise<void> {
  const index = config.mcpServers.findIndex(s => s.name === name);

  if (index === -1) {
    console.error(`❌ MCP server "${name}" not found.`);
    process.exit(1);
  }

  config.mcpServers.splice(index, 1);

  try {
    await configStore.save(config);
    console.log(`✅ Removed MCP server "${name}"`);
    console.log('');
    console.log('Configuration saved to: ~/.bike4mind/config.json');
  } catch (error) {
    console.error(`❌ Failed to save configuration:`, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Enable an MCP server
 */
async function handleEnable(config: CliConfig, name: string, configStore: ConfigStore): Promise<void> {
  const server = config.mcpServers.find(s => s.name === name);

  if (!server) {
    console.error(`❌ MCP server "${name}" not found.`);
    process.exit(1);
  }

  if (server.enabled) {
    console.log(`ℹ️  MCP server "${name}" is already enabled.`);
    return;
  }

  server.enabled = true;

  try {
    await configStore.save(config);
    console.log(`✅ Enabled MCP server "${name}"`);
    console.log('');
    console.log('The server will connect next time you start the CLI.');
  } catch (error) {
    console.error(`❌ Failed to save configuration:`, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Disable an MCP server
 */
async function handleDisable(config: CliConfig, name: string, configStore: ConfigStore): Promise<void> {
  const server = config.mcpServers.find(s => s.name === name);

  if (!server) {
    console.error(`❌ MCP server "${name}" not found.`);
    process.exit(1);
  }

  if (!server.enabled) {
    console.log(`ℹ️  MCP server "${name}" is already disabled.`);
    return;
  }

  server.enabled = false;

  try {
    await configStore.save(config);
    console.log(`✅ Disabled MCP server "${name}"`);
    console.log('');
    console.log('The server will not connect next time you start the CLI.');
  } catch (error) {
    console.error(`❌ Failed to save configuration:`, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
