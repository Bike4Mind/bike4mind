import type { BuildQueuePairOptions } from './queueFactory.js';

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

/**
 * A queue + DLQ pair built with buildQueuePair, whose DLQ is alarmed and listed in the admin
 * DLQ registry. `name` and the DLQ name are used verbatim as SST logical names, so a queue
 * that moves here from infra/queues.ts keeps its resources, provided it states its current
 * encryption: an unset `encryption` means 'kms' here, not buildQueuePair's 'none'.
 */
export interface ContributedQueueSpec extends BuildQueuePairOptions {
  /** Kebab-case DLQ label for alarm names and registry lookups. */
  label: string;
  displayName: string;
  /** Application tag for CloudWatch grouping. */
  application: string;
}

export interface InfraResourceContributions {
  secrets: ContributedSecretSpec[];
  rotations: ContributedSecretRotationSpec[];
  queues: ContributedQueueSpec[];
}

export const EMPTY_INFRA_RESOURCE_CONTRIBUTIONS: InfraResourceContributions = {
  secrets: [],
  rotations: [],
  queues: [],
};

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
  // Core reads these from process.env but infra/ never sets them, so the core-name scan misses them.
  'DOCUMENTDB_CA_BUNDLE_BASE64',
  'AGENT_EXECUTOR_INTERNAL_SECRET',
  'INTERNAL_WS_SECRET',
  'INTERNAL_S3_WEBHOOK_SECRET',
]);

function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIXES.some(prefix => name.startsWith(prefix));
}

export function isValidContributedResourceName(name: unknown): name is string {
  return typeof name === 'string' && RESOURCE_NAME_PATTERN.test(name) && !isReservedEnvName(name);
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

const QUEUE_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const DLQ_LABEL_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// The duration forms sst.aws.Queue accepts for visibilityTimeout, capped at the SQS 12-hour ceiling.
const VISIBILITY_TIMEOUT_PATTERN = /^(\d+) (second|minute|hour)s?$/;
const SECONDS_PER_UNIT = { second: 1, minute: 60, hour: 3600 } as const;
const MAX_VISIBILITY_TIMEOUT_SECONDS = 43200;

function isValidVisibilityTimeout(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = VISIBILITY_TIMEOUT_PATTERN.exec(value);
  if (!match) return false;
  const seconds = Number(match[1]) * SECONDS_PER_UNIT[match[2] as keyof typeof SECONDS_PER_UNIT];
  return seconds <= MAX_VISIBILITY_TIMEOUT_SECONDS;
}

const isIntBetween = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
// infra/dlqAlarms.ts names the alarm pipeline's own DLQ alarms as if this were a label.
const RESERVED_DLQ_LABELS = new Set(['alarm-handler-dlq']);

// Mirrors toEnvKey in b4m-core/resource/src/index.ts; keep in sync.
function toEnvKey(name: string): string {
  if (/^[A-Z0-9_]+$/.test(name)) return name;
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** The logical names buildQueuePair gives a spec: the source queue and its DLQ. */
export function contributedQueueNames(spec: Pick<BuildQueuePairOptions, 'name' | 'dlqName'>): [string, string] {
  return [spec.name, spec.dlqName ?? `${spec.name}DLQ`];
}

/** buildQueuePair options for a contributed pair: encrypted unless the spec opts out. */
export function contributedQueuePairOptions(spec: ContributedQueueSpec): BuildQueuePairOptions {
  return { ...spec, encryption: spec.encryption ?? 'kms' };
}

export interface CoreQueueNames {
  /** SST link names core declares. */
  resourceNames: Iterable<string>;
  /** Env var names core owns; compared against the env form of each queue name. */
  envNames: Iterable<string>;
  /** DLQ labels core already alarms or registers. */
  dlqLabels: Iterable<string>;
}

/**
 * The generated module infra/ and server-utils both import
 * (premium-generated/infraResources.generated.ts).
 */
export interface GeneratedInfraResources {
  contributedInfraResources: InfraResourceContributions;
  coreResourceNames: readonly string[] | null;
  coreEnvNames: readonly string[] | null;
  coreDlqLabels: readonly string[] | null;
}

/**
 * The names a contributed pair may not take. infra/queues.ts and the runtime DLQ registry both
 * call this, so what deploys and what the registry lists are dropped by the same rules. Every
 * declared contributed secret is reserved, whether or not it registered. Null when codegen
 * could not read the core names.
 */
export function reservedQueueNames(generated: GeneratedInfraResources): CoreQueueNames | null {
  const { coreResourceNames, coreEnvNames, coreDlqLabels, contributedInfraResources } = generated;
  if (coreResourceNames === null || coreEnvNames === null || coreDlqLabels === null) return null;
  return {
    resourceNames: [...coreResourceNames, ...contributedInfraResources.secrets.map(spec => String(spec.name))],
    envNames: coreEnvNames,
    dlqLabels: coreDlqLabels,
  };
}

/**
 * Same contract as partitionContributed, applied to both factory-built names of each pair
 * (the queue and its DLQ) and to its label. A spec is dropped whole when any of them is
 * invalid or taken; names are compared raw and in env form, since a link name and its
 * env form address the same value on the self-host shim, and an env form that is a reserved
 * variable counts as invalid.
 */
export function partitionContributedQueues(
  specs: readonly ContributedQueueSpec[],
  core: CoreQueueNames
): PartitionedContributions<ContributedQueueSpec> {
  const result: PartitionedContributions<ContributedQueueSpec> = {
    registered: [],
    coreCollisions: [],
    duplicates: [],
    rejected: [],
  };
  const coreNames = new Set(core.resourceNames);
  const coreEnv = new Set(core.envNames);
  const coreLabels = new Set(core.dlqLabels);
  const seenNames = new Set<string>();
  const seenLabels = new Set<string>();
  for (const spec of specs) {
    const label = spec.label;
    const names = typeof spec.name === 'string' ? contributedQueueNames(spec) : [String(spec.name)];
    const id = `${names.join('/')} (${String(label)})`;
    const valid =
      names.every(n => typeof n === 'string' && QUEUE_NAME_PATTERN.test(n)) &&
      names[0] !== names[1] &&
      isValidVisibilityTimeout(spec.visibilityTimeout) &&
      (spec.retry === undefined || isIntBetween(spec.retry, 1, 1000)) &&
      (spec.dlqMessageRetentionSeconds === undefined || isIntBetween(spec.dlqMessageRetentionSeconds, 60, 1209600)) &&
      typeof label === 'string' &&
      DLQ_LABEL_PATTERN.test(label) &&
      !RESERVED_DLQ_LABELS.has(label);
    if (!valid) {
      result.rejected.push(id);
      continue;
    }
    const envForms = names.map(toEnvKey);
    if (envForms.some(isReservedEnvName)) {
      result.rejected.push(id);
      continue;
    }
    if (
      names.some(n => coreNames.has(n)) ||
      envForms.some(n => coreEnv.has(n) || coreNames.has(n)) ||
      coreLabels.has(label)
    ) {
      result.coreCollisions.push(id);
    } else if (names.some(n => seenNames.has(n)) || envForms.some(n => seenNames.has(n)) || seenLabels.has(label)) {
      result.duplicates.push(id);
    } else {
      for (const n of [...names, ...envForms]) seenNames.add(n);
      seenLabels.add(label);
      result.registered.push(spec);
    }
  }
  return result;
}
