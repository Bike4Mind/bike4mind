// API environment flags (--dev / --prod), split out of argv before yargs parses it.
// They're accepted with either a single or double dash (e.g. `b4m -prod` and
// `b4m --prod` both work), but single-dash multi-char tokens would otherwise be
// split into clustered short flags by yargs (`-prod` -> `-p -r -o -d`, colliding
// with -p/--prompt), so they are removed here and recorded as the target.
export const ENV_FLAG_MAP = {
  '--dev': 'dev',
  '-dev': 'dev',
  '--local': 'dev',
  '-local': 'dev',
  '--prod': 'prod',
  '-prod': 'prod',
  '--production': 'prod',
  '-production': 'prod',
};

const LOCAL_TOKENS = new Set(['--local', '-local']);

// Top-level options that take the next token as their value, so that token is not a positional
// (`b4m --ollama-host <url> mcp serve --local`). Array options take every following non-flag token,
// as yargs parses them. Must stay in sync with the global options in bike4mind-cli.mjs;
// envFlags.test.ts checks it.
export const VALUE_OPTIONS = new Set([
  '--prompt',
  '-p',
  '--output-format',
  '--permission-policy',
  '--ollama-host',
  '--mcp-config',
  '--append-system-prompt',
  '--settings',
  '--session-id',
  '--resume',
  '--api-url',
]);
export const ARRAY_OPTIONS = new Set(['--add-dir', '--allowedTools', '--allowed-tools']);

function positionalIndexes(args) {
  const positionals = [];
  let takesNext = false;
  let inArray = false;
  args.forEach((token, index) => {
    if (takesNext) {
      takesNext = false;
    } else if (Object.prototype.hasOwnProperty.call(ENV_FLAG_MAP, token)) {
      // Stripped before yargs sees argv, so it neither ends an array option nor is a positional.
    } else if (token.startsWith('-')) {
      takesNext = VALUE_OPTIONS.has(token);
      inArray = ARRAY_OPTIONS.has(token);
    } else if (!inArray) {
      positionals.push(index);
    }
  });
  return positionals;
}

/**
 * Split the environment flags out of `args` (argv without node and the script).
 *
 * `mcpServe` is true when `mcp` is the first positional and `serve` the next one. Only then, and only
 * after `serve`, is `--local` serve's own flag (local model tools only), kept as `--local` and reported
 * as `serveLocal`; everywhere else it is the --dev alias. `envFlags` lists the env tokens removed.
 */
export function splitEnvFlags(args) {
  const positionals = positionalIndexes(args);
  const mcpServe = args[positionals[0]] === 'mcp' && args[positionals[1]] === 'serve';
  const serveIndex = mcpServe ? positionals[1] : Infinity;

  const cleaned = [];
  const envFlags = [];
  let envTarget = null;
  let serveLocal = false;
  args.forEach((token, index) => {
    if (index > serveIndex && LOCAL_TOKENS.has(token)) {
      cleaned.push('--local');
      serveLocal = true;
    } else if (index > serveIndex && /^--?local=/.test(token)) {
      const value = token.slice(token.indexOf('=') + 1);
      cleaned.push(`--local=${value}`);
      serveLocal = value !== 'false';
    } else if (Object.prototype.hasOwnProperty.call(ENV_FLAG_MAP, token)) {
      envTarget = ENV_FLAG_MAP[token]; // last one wins
      envFlags.push(token);
    } else {
      cleaned.push(token);
    }
  });
  return { cleaned, envTarget, envFlags, mcpServe, serveLocal };
}
