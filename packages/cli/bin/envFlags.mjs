// API environment flags (--dev / --prod), split out of argv before yargs parses it.
// They're accepted with either a single or double dash (e.g. `b4m -prod` and
// `b4m --prod` both work), but single-dash multi-char tokens would otherwise be
// split into clustered short flags by yargs (`-prod` -> `-p -r -o -d`, colliding
// with -p/--prompt), so they are removed here and recorded as the target.
export const ENV_FLAG_MAP = {
  '--dev': 'dev', '-dev': 'dev', '--local': 'dev', '-local': 'dev',
  '--prod': 'prod', '-prod': 'prod', '--production': 'prod', '-production': 'prod',
};

const LOCAL_TOKENS = new Set(['--local', '-local']);

/**
 * Split the environment flags out of `args` (argv without node and the script).
 *
 * `mcpServe` is true when `mcp` is the first positional and `serve` the next one. Only then, and only
 * after `serve`, is `--local` serve's own flag (local model tools only), kept as `--local` and reported
 * as `serveLocal`; everywhere else it is the --dev alias. `envFlags` lists the env tokens removed.
 */
export function splitEnvFlags(args) {
  const positionals = [];
  args.forEach((token, index) => {
    if (!token.startsWith('-')) positionals.push(index);
  });
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
    } else if (Object.prototype.hasOwnProperty.call(ENV_FLAG_MAP, token)) {
      envTarget = ENV_FLAG_MAP[token]; // last one wins
      envFlags.push(token);
    } else {
      cleaned.push(token);
    }
  });
  return { cleaned, envTarget, envFlags, mcpServe, serveLocal };
}
