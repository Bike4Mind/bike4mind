// Infra resources an overlay declares as plain data in its package.json
// (`b4mContributions.infraResources`). Codegen copies them into
// infra/premium-generated/ and packages/server-utils/src/premium-generated/.

export interface ContributedSecretSpec {
  /** SST secret name, used verbatim as the resource name and the link key. */
  name: string;
  /** Value an unset stage resolves to. Defaults to 'not-configured'. */
  placeholder?: string;
  /** Also expose the value as a plain env var on the agent and chat Lambdas. */
  env?: boolean;
}

export interface ContributedSecretRotationSpec {
  /** Must name a registered contributed secret. */
  secret: string;
  description: string;
  rotationIntervalDays: number;
  isAutomatic: boolean;
  rotationProcess: string;
}

export interface InfraResourceContributions {
  secrets: ContributedSecretSpec[];
  rotations: ContributedSecretRotationSpec[];
}

export const EMPTY_INFRA_RESOURCE_CONTRIBUTIONS: InfraResourceContributions = { secrets: [], rotations: [] };

// Upper snake case only: a contributed name doubles as an env var (the env option and the
// self-host fallback), and toEnvKey maps any other casing onto a different variable, so
// 'MongodbUri' would read MONGODB_URI.
const RESOURCE_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// Variables the runtime, the platform or core already own; a contribution must not set or read them.
const RESERVED_ENV_PREFIXES = [
  'AWS_',
  'AMAZON_',
  'LAMBDA_',
  'ECS_',
  'LD_',
  'NODE_',
  'NPM_',
  'SST_',
  'NEXT_',
  'B4M_',
  'OPENSSL_',
];
const RESERVED_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'PWD',
  'SHELL',
  'USER',
  'HOSTNAME',
  'LANG',
  'TZ',
  'TMPDIR',
  'PORT',
  // Outbound HTTP clients read these, so setting one reroutes or re-trusts every request.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);

export function isValidContributedResourceName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    RESOURCE_NAME_PATTERN.test(name) &&
    !RESERVED_ENV_NAMES.has(name) &&
    !RESERVED_ENV_PREFIXES.some(prefix => name.startsWith(prefix))
  );
}

export interface PartitionedContributions<T> {
  registered: T[];
  /** Names a core resource already owns. Core wins; the contribution is dropped. */
  coreCollisions: string[];
  /** Names declared more than once. The first declaration wins. */
  duplicates: string[];
  /** Names that fail validation (empty, not upper snake case, a reserved env var). */
  rejected: string[];
}

/**
 * Split contributions into the ones safe to register and the ones to drop, so the
 * infra side and the runtime side apply the same rules to the same data.
 */
export function partitionContributed<T>(
  items: readonly T[],
  nameOf: (item: T) => unknown,
  coreNames: ReadonlySet<string>
): PartitionedContributions<T> {
  const result: PartitionedContributions<T> = { registered: [], coreCollisions: [], duplicates: [], rejected: [] };
  const seen = new Set<string>();
  for (const item of items) {
    const name = nameOf(item);
    if (!isValidContributedResourceName(name)) {
      result.rejected.push(String(name));
    } else if (coreNames.has(name)) {
      result.coreCollisions.push(name);
    } else if (seen.has(name)) {
      result.duplicates.push(name);
    } else {
      seen.add(name);
      result.registered.push(item);
    }
  }
  return result;
}

export function describeDroppedContributions(kind: string, result: PartitionedContributions<unknown>): string[] {
  const lines: string[] = [];
  if (result.rejected.length) lines.push(`invalid ${kind} name(s) dropped: ${result.rejected.join(', ')}`);
  if (result.coreCollisions.length)
    lines.push(`${kind}(s) colliding with core dropped: ${result.coreCollisions.join(', ')}`);
  if (result.duplicates.length) lines.push(`duplicate ${kind}(s) dropped: ${result.duplicates.join(', ')}`);
  return lines;
}
