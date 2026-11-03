/**
 * How many leading tokens name "the command" a person would recognise, so an "always allow" can
 * say `git commit *` rather than the one literal line that was approved. Ported from opencode's
 * permission/arity.ts: the longest listed prefix wins, flags never count, and a command that is
 * not listed is its first word alone.
 */
const ARITY: Readonly<Record<string, number>> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  'bun run': 3,
  'bun x': 3,
  cargo: 2,
  'cargo add': 3,
  'cargo run': 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  'consul kv': 3,
  crictl: 2,
  deno: 2,
  'deno task': 3,
  doctl: 3,
  docker: 2,
  'docker builder': 3,
  'docker compose': 3,
  'docker container': 3,
  'docker image': 3,
  'docker network': 3,
  'docker volume': 3,
  eksctl: 2,
  'eksctl create': 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  'git config': 3,
  'git remote': 3,
  'git stash': 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  'ip addr': 3,
  'ip link': 3,
  'ip netns': 3,
  'ip route': 3,
  kind: 2,
  'kind create': 3,
  kubectl: 2,
  'kubectl kustomize': 3,
  'kubectl rollout': 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  'mc admin': 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  'npm exec': 3,
  'npm init': 3,
  'npm run': 3,
  'npm view': 3,
  nvm: 2,
  nx: 2,
  openssl: 2,
  'openssl req': 3,
  'openssl x509': 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  'pnpm dlx': 3,
  'pnpm exec': 3,
  'pnpm run': 3,
  poetry: 2,
  podman: 2,
  'podman container': 3,
  'podman image': 3,
  psql: 2,
  pulumi: 2,
  'pulumi stack': 3,
  pyenv: 2,
  python: 2,
  rake: 2,
  rbenv: 2,
  'redis-cli': 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  'terraform workspace': 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  'vault auth': 3,
  'vault kv': 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  'yarn dlx': 3,
  'yarn run': 3,
};

export function arityPrefix(tokens: readonly string[]): string[] {
  for (let length = tokens.length; length > 0; length -= 1) {
    const arity = ARITY[tokens.slice(0, length).join(' ')];
    if (arity !== undefined) return tokens.slice(0, arity);
  }
  return tokens.slice(0, 1);
}

export const PACKAGE_VALUE_OPTIONS = ['--filter', '-F', '-C', '--dir', '--prefix'];

const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  pnpm: PACKAGE_VALUE_OPTIONS,
  npm: PACKAGE_VALUE_OPTIONS,
  yarn: PACKAGE_VALUE_OPTIONS,
  git: ['-C', '-c'],
};

// Options that only pick where a command runs or how it prints. Anything else dropped before the
// subcommand can change what runs - `git -c core.fsmonitor=<cmd>`, `--exec-path`,
// `npm --script-shell` - so a command carrying one is never covered by a remembered pattern.
const SAFE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  pnpm: PACKAGE_VALUE_OPTIONS,
  npm: PACKAGE_VALUE_OPTIONS,
  yarn: PACKAGE_VALUE_OPTIONS,
  git: ['-C', '--no-pager', '-P'],
};

function leadingOptions(tokens: readonly string[]): { end: number; safe: boolean } {
  const [program, ...rest] = tokens;
  const valued = program === undefined ? undefined : VALUE_OPTIONS[program];
  if (!valued) return { end: 0, safe: true };
  const safeNames = SAFE_OPTIONS[program] ?? [];
  let index = 0;
  let safe = true;
  while (index < rest.length && rest[index].startsWith('-')) {
    const option = rest[index];
    const equals = option.indexOf('=');
    if (!safeNames.includes(equals === -1 ? option : option.slice(0, equals))) safe = false;
    index += valued.includes(option) ? 2 : 1;
  }
  return { end: index, safe };
}

/**
 * The command with the options that sit between the program and its subcommand dropped, so
 * `pnpm --filter @x/y exec vitest run` is `pnpm exec vitest run` and `git -C dir commit` is
 * `git commit`. Both the prefix an "always allow" remembers and the match against it use this
 * form, so the two stay consistent - which is only sound when droppedOnlySafeOptions holds.
 */
export function commandTokens(tokens: readonly string[]): string[] {
  const [program, ...rest] = tokens;
  if (program === undefined) return [];
  return [program, ...rest.slice(leadingOptions(tokens).end)];
}

/** Whether every option commandTokens drops is on the safe list for its program. */
export function droppedOnlySafeOptions(tokens: readonly string[]): boolean {
  return leadingOptions(tokens).safe;
}

const DIRECTORY_OPTIONS = new Set(['-C', '--dir', '--prefix']);

/**
 * The directories that dropped `-C`, `--dir` and `--prefix` options point the command at. Those
 * options are safe to drop only because the caller checks these paths as it would a `cd` target.
 */
export function directoryOptionValues(tokens: readonly string[]): string[] {
  const [program, ...rest] = tokens;
  const valued = program === undefined ? undefined : VALUE_OPTIONS[program];
  if (!valued) return [];
  const values: string[] = [];
  let index = 0;
  while (index < rest.length && rest[index].startsWith('-')) {
    const option = rest[index];
    const equals = option.indexOf('=');
    const name = equals === -1 ? option : option.slice(0, equals);
    if (DIRECTORY_OPTIONS.has(name) && valued.includes(name)) {
      const value = equals === -1 ? rest[index + 1] : option.slice(equals + 1);
      if (value !== undefined) values.push(value);
    }
    index += valued.includes(option) ? 2 : 1;
  }
  return values;
}
