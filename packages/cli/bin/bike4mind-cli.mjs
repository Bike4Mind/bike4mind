#!/usr/bin/env node
 

// Executable entry point for the CLI: tsx runs the TypeScript source in dev,
// the compiled JavaScript in production.

// Suppress punycode deprecation warning from older deps using Node's built-in punycode.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' && warning.message.includes('punycode')) {
    return;
  }
  console.warn(warning);
});

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { splitEnvFlags } from './envFlags.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Read our own package.json so `--version` reports the CLI's version.
// Without an explicit argument, yargs .version() resolves the version from
// whichever package.json it discovers first, which is not necessarily ours.
const { version: cliVersion } = require('../package.json');

// --- API environment flags (--dev / --prod) ---
// Intercept these BEFORE yargs parses argv (see envFlags.mjs) and strip them so
// yargs sees a clean argv.
const { cleaned: cleanedArgs, envTarget, envFlags, mcpServe, serveLocal } = splitEnvFlags(process.argv.slice(2));
if (serveLocal && envTarget) {
  process.stderr.write(`Error: mcp serve --local ignores the backend; drop ${envFlags.join(' ')}.\n`);
  process.exit(1);
}
process.argv = [process.argv[0], process.argv[1], ...cleanedArgs];

const argv = await yargs(hideBin(process.argv))
  // --dev / --prod are declared here ONLY so they appear in `--help`. The actual
  // handling is the pre-yargs argv interception above - these yargs-side values
  // (`argv.dev` / `argv.prod`) are never read.
  .option('dev', {
    type: 'boolean',
    description: 'Point the CLI at the local dev server (http://localhost:3000) and remember it',
  })
  .option('prod', {
    type: 'boolean',
    description: 'Point the CLI at Bike4Mind production and remember it',
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Show debug logs in console',
    default: false,
  })
  .option('debug-stream', {
    type: 'boolean',
    description: 'Ultra-verbose: log every SSE event (for debugging stream parser)',
    default: false,
  })
  .option('no-project-config', {
    type: 'boolean',
    description: 'Disable loading project-specific configuration (.bike4mind/)',
    default: false,
  })
  .option('add-dir', {
    type: 'array',
    description: 'Add additional directories for file access (can be used multiple times)',
    string: true,
  })
  .option('prompt', {
    alias: 'p',
    type: 'string',
    description: 'Run a single query in headless/non-interactive mode and exit',
  })
  .option('output-format', {
    type: 'string',
    description: 'Output format when using -p: text (default), json, stream-json (NDJSON); json also applies to b4m models ls/search/show/curated',
    choices: ['text', 'json', 'stream-json'],
    default: 'text',
  })
  .option('dangerously-skip-permissions', {
    type: 'boolean',
    description: 'When using -p, auto-allow all tool permission prompts (use with caution in CI/CD)',
    default: false,
  })
  .option('permission-policy', {
    type: 'string',
    description: 'When using -p, path to a JSON permission policy for unattended runs (allow/deny/risk rules)',
  })
  .option('ollama-host', {
    type: 'string',
    description: 'Add local Ollama models to the model picker (e.g. http://localhost:11434); `b4m models` remembers it',
  })
  // claude-compatible flags (host drop-in masquerade). Declared so a host's
  // claude launch flags parse into named options instead of leaking into the
  // positional `argv._` task. See packages/cli README "host app".
  .option('mcp-config', {
    type: 'string',
    description: 'Path to a JSON file of MCP servers to inject ({ "mcpServers": {...} })',
  })
  .option('strict-mcp-config', {
    type: 'boolean',
    description: 'Use ONLY --mcp-config servers; ignore file-config and .mcp.json',
    default: false,
  })
  .option('append-system-prompt', {
    type: 'string',
    description: 'Text appended verbatim to the end of the composed system prompt',
  })
  .option('allowedTools', {
    type: 'array',
    string: true,
    description: 'Tool names/globs auto-approved without a permission prompt (e.g. mcp__manifold__*)',
  })
  .option('settings', {
    type: 'string',
    description: 'Inline JSON settings (currently: lifecycle hooks) merged over user config',
  })
  .option('session-id', {
    type: 'string',
    description: 'Pin this session to a fixed uuid (first launch of a resumable pane)',
  })
  .option('resume', {
    type: 'string',
    description: 'Resume an existing session by uuid',
  })
  .option('api-url', {
    type: 'string',
    description: 'Set a custom API URL (self-hosted instance) and clear auth tokens, then exit',
  })
  .option('no-remote-skills', {
    type: 'boolean',
    description: 'Skip fetching B4M-web skills for this run (local files only)',
    default: false,
  })
  .option('reset-api', {
    type: 'boolean',
    description: 'Reset the API URL to the Bike4Mind default and clear auth tokens, then exit',
    default: false,
  })
  .command('mcp', 'Manage MCP (Model Context Protocol) servers', (yargs) => {
    return yargs
      .command('list', 'List configured MCP servers', {}, async () => {
        // Handled by external command handler
      })
      .command('add <name>', 'Add a new MCP server', (yargs) => {
        return yargs
          .positional('name', {
            type: 'string',
            describe: 'Server name',
          })
          .example('b4m mcp add context7 -- npx -y @upstash/context7-mcp', 'Add context7 MCP server')
          .example('b4m mcp add github -- docker run -i ghcr.io/modelcontextprotocol/servers/github', 'Add GitHub MCP server');
      }, async () => {
        // Handled by external command handler
      })
      .command('remove <name>', 'Remove an MCP server', (yargs) => {
        return yargs.positional('name', {
          type: 'string',
          describe: 'Server name',
        });
      }, async () => {
        // Handled by external command handler
      })
      .command('enable <name>', 'Enable an MCP server', (yargs) => {
        return yargs.positional('name', {
          type: 'string',
          describe: 'Server name',
        });
      }, async () => {
        // Handled by external command handler
      })
      .command('disable <name>', 'Disable an MCP server', (yargs) => {
        return yargs.positional('name', {
          type: 'string',
          describe: 'Server name',
        });
      }, async () => {
        // Handled by external command handler
      })
      .command('serve', 'Run Bike4Mind as an MCP server (stdio by default, or --http)', (yargs) => {
        return yargs
          .option('http', {
            type: 'boolean',
            description: 'Serve over streamable HTTP instead of stdio',
            default: false,
          })
          .option('local', {
            type: 'boolean',
            description: 'Serve only the local model tools (models_*), with no Bike4Mind backend. Stdio only',
            default: false,
          })
          .option('port', {
            type: 'number',
            description: 'Port for --http mode',
            default: 7000,
          })
          .option('api-key', {
            type: 'string',
            description: 'Bike4Mind API key (overrides B4M_API_KEY and the stored login). Visible in process listings; prefer B4M_API_KEY',
          })
          .option('api-url', {
            type: 'string',
            description: 'Bike4Mind API URL (overrides B4M_API_URL and the configured backend)',
          })
          .option('token', {
            type: 'string',
            description: 'Bearer token required by --http mode (overrides B4M_MCP_TOKEN; generated and printed when unset). Visible in process listings; prefer B4M_MCP_TOKEN',
          })
          .example('b4m mcp serve', 'Serve over stdio for Claude Desktop and other local clients')
          .example('b4m mcp serve --local', 'Serve only the local model tools, without a backend')
          .example('b4m mcp serve --http --port 7000', 'Serve over streamable HTTP on port 7000');
      }, async () => {
        // Handled by external command handler
      })
      .demandCommand(1, 'You must provide a subcommand (list, add, remove, enable, disable, serve)');
  })
  .command('plugin', 'Manage B4M feature-module plugins', (yargs) => {
    return yargs
      .command('list', 'List installed plugins', {}, async () => {
        // Handled by external command handler
      })
      .command('add <spec>', 'Install a plugin package', (yargs) => {
        return yargs
          .positional('spec', {
            type: 'string',
            describe: 'npm package, @scope/package, github:user/repo, or file:<path>',
          })
          .example('b4m plugin add @someone/b4m-plugin-foo', 'Install from npm')
          .example('b4m plugin add github:user/b4m-plugin-foo', 'Install from GitHub');
      }, async () => {
        // Handled by external command handler
      })
      .command('remove <name>', 'Uninstall a plugin', (yargs) => {
        return yargs.positional('name', {
          type: 'string',
          describe: 'Plugin name (config key, package name, or short name)',
        });
      }, async () => {
        // Handled by external command handler
      })
      .demandCommand(1, 'You must provide a subcommand (list, add, remove)');
  })
  .command('skills', 'Manage your Bike4Mind skills', (yargs) => {
    return yargs
      .command('push <path>', 'Create or update a skill from a Claude Code SKILL.md, and optionally publish it', (yargs) => {
        return yargs
          .positional('path', {
            type: 'string',
            describe: 'Skill folder, its SKILL.md, or a commands/*.md file',
          })
          .option('update', {
            type: 'boolean',
            description: 'Overwrite your existing skill with the same name without asking',
            default: false,
          })
          .option('yes', {
            type: 'boolean',
            description: "Push another author's Skill Market skill as your own without asking",
            default: false,
          })
          .option('publish', {
            type: 'boolean',
            description: 'Also list it on the Skill Market: a new listing, or a new version of its live listing',
            default: false,
          })
          .option('visibility', {
            type: 'string',
            choices: ['organization', 'public', 'unlisted'],
            description: 'Who can see a new listing (with --publish)',
            default: 'organization',
          })
          .option('org', {
            type: 'string',
            description: 'Organization id for an organization listing; optional when you belong to exactly one',
          })
          .option('tags', {
            type: 'string',
            description: 'Comma-separated listing tags (with --publish)',
          })
          .option('api-key', {
            type: 'string',
            description:
              'Bike4Mind API key with the skills:write and me:read scopes (overrides B4M_API_KEY and the stored login). Visible in process listings; prefer B4M_API_KEY, which also takes precedence over the stored login when set, even without --publish',
          })
          .example('b4m skills push ~/.claude/skills/my-skill', 'Create a skill from a Claude Code skill folder')
          .example('b4m skills push ./SKILL.md --update', 'Update the existing skill of the same name')
          .example('b4m skills push ./my-skill --publish --update', 'Update the skill and publish it to the Skill Market');
      }, async () => {
        // Handled by external command handler
      })
      .demandCommand(1, 'You must provide a subcommand (push)');
  })
  .command('models', 'Find, download and use local models (Ollama, Hugging Face GGUF)', (yargs) => {
    return yargs
      .option('server', {
        type: 'string',
        description: "Run ls, use, pull or rm against one of Desktop's saved model servers (see: b4m models servers)",
      })
      .command(['ls', 'list'], 'List models installed on the local runtime', {}, async () => {
        // Handled by external command handler
      })
      .command('servers [action] [name]', "List Desktop's saved model servers, or log in or out of one", (yargs) => {
        return yargs
          .positional('action', { type: 'string', choices: ['login', 'logout'], describe: 'Keep or remove the CLI\'s credential for a server' })
          .positional('name', { type: 'string', describe: 'Server name, as `b4m models servers` shows it' })
          .option('check-tools', {
            type: 'boolean',
            description: 'servers: send each OpenAI-compatible server a one-token request to see whether it accepts tool calls',
            default: false,
          })
          .option('token-stdin', {
            type: 'boolean',
            description: 'login: read the credential from stdin instead of prompting',
            default: false,
          })
          .example('b4m models servers', 'List the servers with their status')
          .example('b4m models servers login gpu-box', 'Enter the CLI\'s credential for gpu-box (hidden)');
      }, async () => {
        // Handled by external command handler
      })
      .command('search <query..>', 'Search Hugging Face for GGUF models', (yargs) => {
        return yargs
          .positional('query', { type: 'string', describe: 'Search terms' })
          .option('include-abliterated', {
            type: 'boolean',
            description: 'Also list abliterated and uncensored builds, labelled and last',
            default: false,
          });
      }, async () => {
        // Handled by external command handler
      })
      .command('show <repo>', "Show a Hugging Face repo's GGUF builds, license and gating", (yargs) => {
        return yargs.positional('repo', { type: 'string', describe: 'owner/repo' });
      }, async () => {
        // Handled by external command handler
      })
      .command('curated', 'List the models Bike4Mind picked, with picks for this computer first', {}, async () => {
        // Handled by external command handler
      })
      .command('pull <ref>', 'Download a model after showing its size and license', (yargs) => {
        return yargs
          .positional('ref', {
            type: 'string',
            describe: 'owner/repo[:quant] or hf.co/owner/repo:quant (Hugging Face), or an Ollama name like qwen2.5:0.5b',
          })
          .option('yes', {
            type: 'boolean',
            description: 'Download without asking for confirmation',
            default: false,
          })
          .option('accept-license', {
            type: 'boolean',
            description: 'Accept a non-permissive model license without a prompt',
            default: false,
          })
          .option('force', {
            type: 'boolean',
            description: 'Download even when the fit check rates the model too large for this machine',
            default: false,
          })
          .example('b4m models pull Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M', 'Pull a Hugging Face GGUF build')
          .example('b4m models pull qwen2.5:0.5b', 'Pull from the Ollama library');
      }, async () => {
        // Handled by external command handler
      })
      .command(['rm <name>', 'remove <name>'], 'Remove an installed model', (yargs) => {
        return yargs
          .positional('name', { type: 'string', describe: 'Installed model name' })
          .option('yes', {
            type: 'boolean',
            description: 'Remove without asking for confirmation',
            default: false,
          });
      }, async () => {
        // Handled by external command handler
      })
      .command('use <name>', 'Make an installed model the default the CLI chats with', (yargs) => {
        return yargs.positional('name', { type: 'string', describe: 'Installed model name' });
      }, async () => {
        // Handled by external command handler
      })
      .example('b4m models ls --ollama-host http://127.0.0.1:11434', 'Use and remember an Ollama host')
      .demandCommand(1, 'You must provide a subcommand (ls, search, show, curated, servers, pull, rm, use)');
  })
  .command('update', 'Check for and install CLI updates')
  .command('doctor', 'Run diagnostic checks on CLI installation')
  .command('acp', 'Run as an Agent Client Protocol (ACP) stdio server for editors like Zed')
  .help()
  .alias('help', 'h')
  .version(cliVersion)
  .alias('version', 'V')
  .parse();

// Set environment variables from CLI flags
if (argv.verbose) {
  process.env.B4M_VERBOSE = '1';
  process.env.LOG_LEVEL = 'debug'; // Enable debug logs in core packages
}
if (argv['debug-stream']) {
  process.env.B4M_DEBUG_STREAM = '1';
  process.env.B4M_VERBOSE = '1'; // Ultra-verbose implies verbose
  process.env.LOG_LEVEL = 'debug';
}
if (argv['no-project-config']) {
  process.env.B4M_NO_PROJECT_CONFIG = '1';
}
if (argv['add-dir'] && argv['add-dir'].length > 0) {
  // Resolve paths to absolute and pass via environment variable
  const resolvedDirs = argv['add-dir'].map(d => resolve(d));
  process.env.B4M_ADDITIONAL_DIRS = JSON.stringify(resolvedDirs);
}
if (argv['ollama-host']) {
  process.env.B4M_OLLAMA_HOST = argv['ollama-host'];
}
if (argv['no-remote-skills']) {
  process.env.B4M_NO_REMOTE_SKILLS = '1';
}

// claude-compatible flags -> B4M_* env (read by src/index.tsx init).
// Host-launch signal: keep in sync with HOST_FLAG_ENV_KEYS in src/bootstrap/startupTrustGates.ts.
// Mirrors the established bin->env->init channel (cf. --add-dir -> B4M_ADDITIONAL_DIRS).
if (argv['mcp-config']) {
  process.env.B4M_MCP_CONFIG_FILE = resolve(argv['mcp-config']);
}
if (argv['strict-mcp-config']) {
  process.env.B4M_STRICT_MCP_CONFIG = '1';
}
if (argv['append-system-prompt']) {
  process.env.B4M_APPEND_SYSTEM_PROMPT = argv['append-system-prompt'];
}
if (argv.allowedTools && argv.allowedTools.length > 0) {
  // Each element may itself be a space-separated list (the host's board pane passes
  // "a b c" as a single argv token); flatten on whitespace into discrete patterns.
  const patterns = argv.allowedTools.flatMap((s) => String(s).split(/\s+/)).filter(Boolean);
  process.env.B4M_ALLOWED_TOOLS = JSON.stringify(patterns);
}
if (argv.settings) {
  process.env.B4M_SETTINGS_JSON = argv.settings;
}
if (argv['session-id']) {
  process.env.B4M_SESSION_ID = argv['session-id'];
}
if (argv.resume) {
  process.env.B4M_RESUME_ID = argv.resume;
}
// Positional task (claude `<prompt>` form): seeds AND submits turn 1, stays interactive.
// Only when it's not a known subcommand and headless -p wasn't used.
const KNOWN_SUBCOMMANDS = new Set(['mcp', 'plugin', 'skills', 'models', 'update', 'doctor', 'acp']);
if (argv.prompt === undefined && argv._.length > 0 && !KNOWN_SUBCOMMANDS.has(String(argv._[0]))) {
  process.env.B4M_INITIAL_PROMPT = String(argv._[0]);
}

// Auto-detect environment: prefer production mode when dist exists
const distPath = join(__dirname, '../dist/index.mjs');
const srcPath = join(__dirname, '../src/index.tsx');
const hasSource = existsSync(srcPath);
const hasDist = existsSync(distPath);

// Development mode ONLY when:
// 1. NODE_ENV is explicitly 'development', OR
// 2. dist doesn't exist but source does (fallback)
// Otherwise: use production mode (this is what npm users will run)
const isDev = process.env.NODE_ENV === 'development' ||
              (!hasDist && hasSource);

// Signal source mode to the app so endpoint resolution can default an
// otherwise-unconfigured run to the local dev server (build-time brand
// defaults are never injected into a source run). Set before any command
// dispatch below so --reset-api messaging and the app both observe it.
// See resolveApiEndpoint() / isSourceMode() in src/utils/apiUrl.ts.
if (isDev) {
  process.env.B4M_SOURCE_MODE = '1';
}

// Handle --api-url / --reset-api flags
// These mutate ~/.bike4mind/config.json and exit before any auth flow runs,
// so devs can recover from a misconfigured customUrl without editing JSON.
// `mcp serve` has its own ephemeral --api-url (points that one server at a
// backend without touching config), so skip the mutate-and-exit path for it.
if ((argv['reset-api'] || argv['api-url'] !== undefined) && argv._[0] !== 'mcp') {
  try {
    let handleApiCommand;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/apiCommand.ts');
      handleApiCommand = module.handleApiCommand;
    } else {
      const module = await import('../dist/commands/apiCommand.mjs');
      handleApiCommand = module.handleApiCommand;
    }

    if (argv['reset-api']) {
      await handleApiCommand({ mode: 'reset' });
    } else {
      await handleApiCommand({ mode: 'set', url: argv['api-url'] });
    }
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Apply --dev / --prod environment switch before anything connects to a server.
// This persists the choice (sticky: a bare `b4m` reuses the last selection) and
// swaps in that environment's cached auth token.
if (envTarget) {
  try {
    let applyEnvironmentFlag;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      ({ applyEnvironmentFlag } = await import('../src/commands/envCommand.ts'));
    } else {
      ({ applyEnvironmentFlag } = await import('../dist/commands/envCommand.mjs'));
    }

    // On `mcp serve` stdout is the JSON-RPC stream, so the banner goes to stderr.
    const log = console.log;
    if (mcpServe) console.log = console.error;
    try {
      await applyEnvironmentFlag(envTarget);
    } finally {
      console.log = log;
    }
  } catch (error) {
    console.error('Failed to switch API environment:', error.message);
    process.exit(1);
  }
}

// Handle headless mode (-p / --prompt flag)
// Must be done after isDev detection to use correct import path
if (argv.prompt !== undefined) {
  const outputFormat = argv['output-format'] || 'text';
  const rawAddDirs = argv['add-dir'] || [];

  try {
    let handleHeadlessCommand;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/headlessCommand.ts');
      handleHeadlessCommand = module.handleHeadlessCommand;
    } else {
      const module = await import('../dist/commands/headlessCommand.mjs');
      handleHeadlessCommand = module.handleHeadlessCommand;
    }

    await handleHeadlessCommand({
      prompt: argv.prompt,
      outputFormat,
      dangerouslySkipPermissions: argv['dangerously-skip-permissions'] || false,
      verbose: argv.verbose || false,
      addDirs: rawAddDirs.map(d => resolve(d)),
      permissionPolicyPath: argv['permission-policy'] ? resolve(argv['permission-policy']) : undefined,
    });
    // handleHeadlessCommand calls process.exit internally, but handle the case it doesn't
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Handle MCP subcommands (external commands)
// Must be done after mode detection to use correct import path
if (argv._[0] === 'mcp') {
  const mcpSubcommand = argv._[1];

  try {
    let handleMcpCommand;

    if (isDev) {
      // Development: use tsx to import TypeScript
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/mcpCommand.ts');
      handleMcpCommand = module.handleMcpCommand;
    } else {
      // Production: import compiled JavaScript
      const module = await import('../dist/commands/mcpCommand.mjs');
      handleMcpCommand = module.handleMcpCommand;
    }

    await handleMcpCommand(mcpSubcommand, argv);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Handle plugin subcommands (external commands)
if (argv._[0] === 'plugin') {
  const pluginSubcommand = argv._[1];

  try {
    let handlePluginCommand;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/pluginCommand.ts');
      handlePluginCommand = module.handlePluginCommand;
    } else {
      const module = await import('../dist/commands/pluginCommand.mjs');
      handlePluginCommand = module.handlePluginCommand;
    }

    await handlePluginCommand(pluginSubcommand, argv);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Handle skills subcommands (external commands)
if (argv._[0] === 'skills') {
  const skillsSubcommand = argv._[1];

  try {
    let handleSkillsCommand;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/skillsCommand.ts');
      handleSkillsCommand = module.handleSkillsCommand;
    } else {
      const module = await import('../dist/commands/skillsCommand.mjs');
      handleSkillsCommand = module.handleSkillsCommand;
    }

    await handleSkillsCommand(skillsSubcommand, argv);
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Handle models subcommands (external commands)
if (argv._[0] === 'models') {
  const modelsSubcommand = argv._[1];

  try {
    let handleModelsCommand;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/modelsCommand.ts');
      handleModelsCommand = module.handleModelsCommand;
    } else {
      const module = await import('../dist/commands/modelsCommand.mjs');
      handleModelsCommand = module.handleModelsCommand;
    }

    process.exit(await handleModelsCommand(modelsSubcommand, argv));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Handle update command (external command)
if (argv._[0] === 'update') {
  try {
    let handleUpdateCommand;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/updateCommand.ts');
      handleUpdateCommand = module.handleUpdateCommand;
    } else {
      const module = await import('../dist/commands/updateCommand.mjs');
      handleUpdateCommand = module.handleUpdateCommand;
    }

    await handleUpdateCommand();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Handle ACP server command (external command)
// stdio is the JSON-RPC transport, so this never returns until the client
// disconnects. Errors go to stderr to keep stdout as a clean protocol stream.
if (argv._[0] === 'acp') {
  try {
    let handleAcpCommand;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/acpCommand.ts');
      handleAcpCommand = module.handleAcpCommand;
    } else {
      const module = await import('../dist/commands/acpCommand.mjs');
      handleAcpCommand = module.handleAcpCommand;
    }

    await handleAcpCommand({ verbose: argv.verbose || false, version: cliVersion });
    process.exit(0);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

// Handle doctor command (external command)
if (argv._[0] === 'doctor') {
  try {
    let handleDoctorCommand;

    if (isDev) {
      const { register } = require('tsx/esm/api');
      register();
      const module = await import('../src/commands/doctorCommand.ts');
      handleDoctorCommand = module.handleDoctorCommand;
    } else {
      const module = await import('../dist/commands/doctorCommand.mjs');
      handleDoctorCommand = module.handleDoctorCommand;
    }

    await handleDoctorCommand();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (isDev) {
  // Note: this is about *how the CLI runs* (unbuilt TypeScript source), which is
  // distinct from the `--dev` flag (which selects the local dev *backend*).
  console.log('🔧 Running from TypeScript source (no dist build)\n');
  // Development: use tsx to run TypeScript
  try {
    const { register } = require('tsx/esm/api');
    register();

    await import(join(__dirname, '../src/index.tsx'));
  } catch (error) {
    console.error('Failed to start CLI in development mode:', error);
    console.error('\nTry running: pnpm install');
    process.exit(1);
  }
} else {
  // Production: run compiled JavaScript
  try {
    // Auto-update on launch (consent-first): when a newer version is available
    // on a writable global prefix, install + re-exec into it BEFORE importing
    // the code-split app - running an install while dist/index.mjs is loaded
    // would crash it. On the default 'ask' preference this prompts the user
    // (Update once / Always / Skip / Never); 'auto' installs silently, 'never'
    // does nothing. Wrapped so the updater can never block launching the CLI.
    try {
      const { maybeAutoUpdateOnLaunch } = await import('../dist/commands/updateCommand.mjs');
      await maybeAutoUpdateOnLaunch();
    } catch {
      // Updater is best-effort - fall through to the current version.
    }

    await import(join(__dirname, '../dist/index.mjs'));
  } catch (error) {
    console.error('Failed to start CLI:', error);
    console.error('\nTry running: pnpm build');
    process.exit(1);
  }
}
