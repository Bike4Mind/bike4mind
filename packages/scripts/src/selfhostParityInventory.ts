import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

/**
 * Static inventory of hosted background triggers declared in infra/, validated against the
 * reviewed policy in selfhostParityPolicy.ts. Static wiring only: nothing here runs SST.
 *
 * Mapping limit: a 'portable' (wired) entry proves the mapped local symbol exists, its imports
 * resolve and it is reachable from the self-host entrypoint. It does not prove the local code
 * is behaviourally equivalent to the hosted handler; the mapping is a reviewed claim and the
 * fingerprints only detect that either side of it changed.
 */

export type ParityKind =
  | 'queue'
  | 'schedule'
  | 'event'
  | 'notification'
  | 'eventRule'
  | 'sesRule'
  | 'logSubscription'
  | 'snsSubscription'
  | 'function'
  | 'service';

/**
 * A hosted handler and whether its source was supplied. 'overlayAbsent' is the one legitimate
 * absence: handlers generated from a private overlay into a gitignored directory, which an
 * open-core checkout does not have. 'missing' is rejected by validateParityPolicy.
 */
export type HandlerSource = { handler: string; file: string; status: 'found' | 'missing' | 'overlayAbsent' };

export interface ParityDeclaration {
  id: string;
  kind: ParityKind;
  name: string;
  declaration: string;
  fingerprint: string;
  handlers: string[];
  handlerSources: HandlerSource[];
  hostedAwsSignals: string[];
}
export interface ParityPolicyEntry {
  id: string;
  fingerprint: string;
  disposition: 'portable' | 'pending' | 'excluded';
  issue: string;
  reason: string;
  hostedAwsSignals: string[];
  portable?: { source: string; symbol: string; fingerprint: string };
}

type ResourceType =
  | 'Queue'
  | 'Cron'
  | 'Bus'
  | 'Function'
  | 'SnsTopic'
  | 'Bucket'
  | 'Service'
  | 'EventRule'
  | 'EventTarget'
  | 'LogSubscriptionFilter'
  | 'ReceiptRule'
  | 'TopicSubscription';
type Resource = { type: ResourceType; file: string; node: ts.NewExpression };
type Definition = ts.VariableDeclaration | ts.FunctionDeclaration;
type Guard = { expression: ts.Expression; branch: 'true' | 'false' };
type RawDeclaration = {
  file: string;
  kind: ParityKind;
  name: string;
  nodes: ts.Node[];
  /** Subscriber arguments of method triggers: a handler string, a `fn.arn` or an inline object. */
  subscribers: ts.Expression[];
};

/** Single source of truth for which constructors the index tracks, keyed by callee text. */
const RESOURCE_CONSTRUCTORS: Readonly<Record<string, ResourceType>> = {
  'sst.aws.Queue': 'Queue',
  'aws.sqs.Queue': 'Queue',
  'sst.aws.Cron': 'Cron',
  'sst.aws.Bus': 'Bus',
  'sst.aws.Function': 'Function',
  'sst.aws.SnsTopic': 'SnsTopic',
  'aws.sns.Topic': 'SnsTopic',
  'sst.aws.Bucket': 'Bucket',
  'sst.aws.Service': 'Service',
  'aws.cloudwatch.EventRule': 'EventRule',
  'aws.cloudwatch.EventTarget': 'EventTarget',
  'aws.cloudwatch.LogSubscriptionFilter': 'LogSubscriptionFilter',
  'aws.ses.ReceiptRule': 'ReceiptRule',
  'aws.sns.TopicSubscription': 'TopicSubscription',
};

/** Constructors that are themselves an inventoried declaration. Others fold into one or are plumbing. */
const DECLARATION_KINDS: Partial<Record<ResourceType, ParityKind>> = {
  Queue: 'queue',
  Cron: 'schedule',
  EventRule: 'eventRule',
  ReceiptRule: 'sesRule',
  LogSubscriptionFilter: 'logSubscription',
  TopicSubscription: 'snsSubscription',
  Service: 'service',
  Function: 'function',
};

/**
 * Hosted shapes deliberately outside the inventory. A `sst.aws.*` / `aws.<ns>.*` constructor that
 * is neither tracked above nor listed here fails discovery, so a new shape cannot slip past silently.
 * Keep in sync with the "Not covered" list in SELF_HOST.md.
 */
export const NOT_COVERED: readonly { shape: string; reason: string }[] = [
  { shape: 'sst.aws.Function with a url option', reason: 'HTTP API surface, not a background trigger.' },
  { shape: 'sst.aws.Nextjs', reason: 'Web app and Pages-API surface.' },
  { shape: 'sst.aws.Router', reason: 'CDN routing to the web surface; .route() adds no background work.' },
  { shape: 'aws.cloudfront.OriginRequestPolicy', reason: 'CDN request-header forwarding, no background work.' },
  { shape: 'sst.aws.ApiGatewayWebSocket', reason: 'Interactive socket routes (.route()), request/response only.' },
  { shape: 'sst.aws.Bucket', reason: 'Storage only; its notify() triggers are inventoried as notification.' },
  { shape: 'sst.aws.Bus', reason: 'Bus only; subscribe()/subscribeQueue() are inventoried as event.' },
  { shape: 'sst.aws.SnsTopic', reason: 'Topic only; subscribe() is inventoried as snsSubscription.' },
  { shape: 'aws.sns.Topic', reason: 'Topic only; aws.sns.TopicSubscription is inventoried as snsSubscription.' },
  { shape: 'aws.cloudwatch.MetricAlarm', reason: 'Alarm only; delivery is inventoried at the topic subscription.' },
  { shape: 'aws.cloudwatch.Dashboard', reason: 'Observability view, no compute.' },
  { shape: 'aws.cloudwatch.LogMetricFilter', reason: 'Metric extraction feeding alarms, no compute.' },
  { shape: 'aws.ssm.Parameter', reason: 'Secret storage for ECS task secrets, no compute.' },
  { shape: 'aws.cloudwatch.LogGroup', reason: 'Log storage, no compute.' },
  { shape: 'aws.lambda.Permission', reason: 'IAM grant for an inventoried trigger.' },
  { shape: 'aws.sqs.QueuePolicy', reason: 'IAM grant for an inventoried queue.' },
  { shape: 'aws.sns.TopicPolicy', reason: 'IAM grant for an inventoried topic.' },
  { shape: 'aws.lambda.Invocation', reason: 'Deploy-time one-shot invoke; the invoked Function is inventoried.' },
  { shape: 'aws.ses.ReceiptRuleSet', reason: 'Container for the inventoried aws.ses.ReceiptRule.' },
  { shape: 'aws.ses.ActiveReceiptRuleSet', reason: 'Activation of the inventoried receipt rule set.' },
  { shape: 'aws.ses.ConfigurationSet', reason: 'Outbound mail metric configuration, no compute.' },
  { shape: 'aws.ses.EventDestination', reason: 'Outbound mail metrics sent to CloudWatch, no compute.' },
  { shape: 'aws.s3.BucketLifecycleConfigurationV2', reason: 'Storage retention policy, not a compute trigger.' },
  { shape: 'sst.aws.Vpc', reason: 'Network plumbing.' },
  { shape: 'sst.aws.Cluster', reason: 'Container host for inventoried sst.aws.Service declarations.' },
  { shape: 'aws.ec2.SecurityGroup', reason: 'Network plumbing.' },
  { shape: 'aws.ec2.SecurityGroupRule', reason: 'Network plumbing.' },
  { shape: 'aws.servicediscovery.Service', reason: 'Service discovery plumbing.' },
  { shape: 'aws.servicediscovery.PrivateDnsNamespace', reason: 'Service discovery plumbing.' },
  { shape: 'aws.wafv2.WebAcl', reason: 'Hosted edge protection, no compute.' },
  { shape: 'aws.wafv2.IpSet', reason: 'Hosted edge protection, no compute.' },
  { shape: 'aws.wafv2.WebAclLoggingConfiguration', reason: 'Hosted edge protection logging, no compute.' },
  { shape: 'premium overlay contributeInfra()', reason: 'Declared in private overlay repos, absent here.' },
];

/**
 * Queue constructors named from package data instead of a literal, keyed by file and the name
 * argument's text. Their names are unknown until a package declares one, so there is no self-host
 * registration to match. An entry must match exactly one constructor: none fails discovery as
 * stale, and more fails it so a second queue cannot borrow the exemption.
 */
export const DATA_NAMED_QUEUES: readonly { file: string; name: string; reason: string }[] = [
  {
    file: 'infra/queues.ts',
    name: 'pair.dlqName',
    reason: 'DLQ of a b4mContributions.infraResources queue pair; self-host does not provision contributed queues.',
  },
  {
    file: 'infra/queues.ts',
    name: 'pair.name',
    reason: 'Source queue of a b4mContributions.infraResources pair; self-host does not provision contributed queues.',
  },
];

const HOSTED_CONSTRUCTOR = /^(?:sst\.aws\.\w+|aws\.\w+\.\w+)$/;
const TRIGGER_METHODS = new Set(['subscribe', 'subscribeQueue', 'notify']);
/** Option keys whose `<resource>.arn` value is the compute or queue a trigger delivers to. */
const TARGET_KEYS = new Set(['job', 'function', 'destinationArn', 'endpoint', 'arn', 'queue']);
/**
 * Fingerprint scope rule: a declaration's own tokens are always hashed, and identifiers it
 * references are followed into their definitions EXCEPT under these keys. They carry runtime
 * sizing, logging and shared environment bags used by nearly every declaration; following them
 * made one new key in a shared env constant invalidate every entry. In-place edits under these
 * keys still change the declaration's own tokens and so still trip.
 */
const NON_PARITY_OPTION_KEYS = new Set([
  'environment',
  'logging',
  'vpc',
  'nodejs',
  'copyFiles',
  'layers',
  'memory',
  'cpu',
  'storage',
  'runtime',
  'architecture',
  'dev',
]);
const REGISTRATION_METHODS: Readonly<Record<string, 'queue' | 'schedule'>> = {
  registerQueueHandler: 'queue',
  registerScheduledTask: 'schedule',
  registerDailyUtcTask: 'schedule',
};
const AWS_EXCLUSIVE = /^(?:bedrock|events|lambda|cloudwatch|ssm|cognito-idp|dynamodb|execute-api):/;
const AWS_EXCLUSIVE_SDK =
  /^@aws-sdk\/client-(?:bedrock(?:-runtime|-agent-runtime)?|eventbridge|lambda|cloudwatch(?:-logs)?|ssm|cognito-identity-provider|dynamodb)$/;
const ENTRYPOINT = 'apps/workers/src/selfhost/main.ts';
const SELFHOST_DIR = 'apps/workers/src/selfhost/';
/** Gitignored; written by scripts/generate-premium-glue.mjs only when an overlay is installed. */
const OVERLAY_GENERATED_HANDLER_DIR = 'apps/client/server/premium-generated/';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function parse(file: string, text: string): ts.SourceFile {
  // transpileModule reports syntactic diagnostics only, through the public API.
  const { diagnostics = [] } = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  });
  if (diagnostics.length) throw new Error(`${file}: cannot parse declaration source`);
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function canonical(node: ts.Node): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.getText());
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return tokens.join(' ');
}

function literal(node: ts.Node | undefined, context: string): string {
  if (!node || !ts.isStringLiteralLike(node)) throw new Error(`${context}: literal name required`);
  return node.text;
}

function strings(node: ts.Node): string[] {
  const values: string[] = [];
  walk(node, child => {
    if (ts.isStringLiteralLike(child)) values.push(child.text);
  });
  return values;
}

function handlerRefs(node: ts.Node): string[] {
  const handlers: string[] = [];
  walk(node, child => {
    if (ts.isPropertyAssignment(child) && child.name.getText() === 'handler') {
      handlers.push(literal(child.initializer, 'handler'));
    }
  });
  return handlers;
}

const handlerFile = (handler: string): string => handler.slice(0, handler.lastIndexOf('.')) + '.ts';

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function propertyName(node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): string | undefined {
  return ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined;
}

function property(options: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const element of options.properties)
    if (ts.isPropertyAssignment(element) && propertyName(element) === name) return element.initializer;
  return undefined;
}

function resourceType(expression: ts.Expression): ResourceType | undefined {
  const callee = expression.getText();
  return Object.hasOwn(RESOURCE_CONSTRUCTORS, callee) ? RESOURCE_CONSTRUCTORS[callee] : undefined;
}

/** Identifiers in reference position, skipping property names and NON_PARITY_OPTION_KEYS values. */
function parityReferences(node: ts.Node): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (current: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) &&
      NON_PARITY_OPTION_KEYS.has(propertyName(current) ?? '')
    )
      return;
    if (ts.isIdentifier(current)) {
      const parent = current.parent;
      const isName =
        (ts.isPropertyAccessExpression(parent) && parent.name === current) ||
        (ts.isPropertyAssignment(parent) && parent.name === current);
      if (!isName) found.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

const fileDefinitionCache = new WeakMap<ts.SourceFile, Map<string, Definition>>();
function fileDefinitions(source: ts.SourceFile): Map<string, Definition> {
  const cached = fileDefinitionCache.get(source);
  if (cached) return cached;
  const declarations = new Map<string, Definition>();
  walk(source, child => {
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) declarations.set(child.name.text, child);
    if (ts.isFunctionDeclaration(child) && child.name) declarations.set(child.name.text, child);
  });
  fileDefinitionCache.set(source, declarations);
  return declarations;
}

/** Same-file definitions referenced (transitively) by node, under the fingerprint scope rule. */
function referencedDefinitions(source: ts.SourceFile, node: ts.Node): ts.Node[] {
  const declarations = fileDefinitions(source);
  const found = new Set<ts.Node>();
  const collect = (current: ts.Node): void => {
    for (const identifier of parityReferences(current)) {
      const declaration = declarations.get(identifier.text);
      if (declaration && declaration !== node && !found.has(declaration)) {
        found.add(declaration);
        collect(declaration);
      }
    }
  };
  collect(node);
  return [...found].sort((a, b) => a.pos - b.pos);
}

function ancestorGuards(node: ts.Node): Guard[] {
  const guards: Guard[] = [];
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && child !== parent.expression)
      guards.push({ expression: parent.expression, branch: child === parent.thenStatement ? 'true' : 'false' });
    if (ts.isConditionalExpression(parent) && child !== parent.condition)
      guards.push({ expression: parent.condition, branch: child === parent.whenTrue ? 'true' : 'false' });
  }
  return guards;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
    if (
      (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
      ts.isVariableDeclaration(parent.parent) &&
      ts.isIdentifier(parent.parent.name)
    )
      return parent.parent.name.text;
  }
  return undefined;
}

class InfraIndex {
  readonly resources = new Map<string, Resource>();
  readonly definitions = new Map<string, Definition>();
  private readonly aliases = new Map<string, string>();

  constructor(readonly parsed: ts.SourceFile[]) {
    const imports: { key: string; target: string }[] = [];
    for (const source of parsed) {
      const file = source.fileName;
      walk(source, node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          this.definitions.set(`${file}:${node.name.text}`, node);
          if (node.initializer) this.indexInitializer(file, node.name.text, node.initializer);
        }
        if (ts.isFunctionDeclaration(node) && node.name) this.definitions.set(`${file}:${node.name.text}`, node);
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          ts.isNewExpression(node.right)
        )
          this.register(file, node.left.text, node.right);
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text.startsWith('.')
        ) {
          const bindings = node.importClause?.namedBindings;
          if (!bindings || !ts.isNamedImports(bindings)) return;
          const module = path.posix.normalize(path.posix.join(path.posix.dirname(file), node.moduleSpecifier.text));
          for (const element of bindings.elements)
            imports.push({
              key: `${file}:${element.name.text}`,
              target: `${module}.ts:${element.propertyName?.text ?? element.name.text}`,
            });
        }
      });
    }
    for (const { key, target } of imports) this.aliases.set(key, target);
  }

  private indexInitializer(file: string, name: string, initializer: ts.Expression): void {
    if (ts.isNewExpression(initializer)) this.register(file, name, initializer);
    if (ts.isIdentifier(initializer)) this.aliases.set(`${file}:${name}`, `${file}:${initializer.text}`);
    if (ts.isConditionalExpression(initializer)) {
      const choices = [initializer.whenTrue, initializer.whenFalse].filter(ts.isNewExpression);
      if (choices.length > 1) throw new Error(`${file}: ambiguous resource ${name}`);
      if (choices[0]) this.register(file, name, choices[0]);
    }
  }

  private register(file: string, name: string, node: ts.NewExpression): void {
    const type = resourceType(node.expression);
    if (type) this.resources.set(`${file}:${name}`, { type, file, node });
  }

  /** The alias-terminal key for an identifier, following re-exports and `const a = b`. */
  terminal(file: string, name: string): string {
    let key = `${file}:${name}`;
    const seen = new Set<string>();
    while (this.aliases.has(key) && !seen.has(key)) {
      seen.add(key);
      const next = this.aliases.get(key);
      if (next === undefined) throw new Error(`${key}: alias vanished while resolving`);
      key = next;
    }
    return key;
  }

  resolve(file: string, name: string): Resource | undefined {
    return this.resources.get(this.terminal(file, name));
  }

  /** One import hop into another file's definition, matching how far imported cadence helpers are followed. */
  importedDefinition(identifier: ts.Identifier): Definition | undefined {
    const target = this.aliases.get(`${identifier.getSourceFile().fileName}:${identifier.text}`);
    return target ? this.definitions.get(target) : undefined;
  }

  /** Resolve `<identifier>.arn` (after `!`/parens) to an indexed resource, or throw. */
  arnTarget(file: string, context: string, expression: ts.Expression): Resource | undefined {
    const value = unwrap(expression);
    if (!ts.isPropertyAccessExpression(value) || value.name.text !== 'arn') return undefined;
    const receiver = unwrap(value.expression);
    if (!ts.isIdentifier(receiver)) return undefined;
    const target = this.resolve(file, receiver.text);
    if (!target) throw new Error(`${context}: unresolved target ${value.getText()}`);
    return target;
  }
}

function declarationName(node: ts.NewExpression, file: string, kind: ParityKind): string {
  const first = node.arguments?.[0];
  if (first && ts.isStringLiteralLike(first)) return first.text;
  // Queue/schedule names are the key local registrations are matched by, so they must be literal.
  // Other kinds built in a named factory (e.g. a per-log-group loop) are identified by that site.
  const site = kind === 'queue' || kind === 'schedule' ? undefined : enclosingFunctionName(node);
  if (site) return `${site}()`;
  return literal(first, file);
}

function constructorOptions(node: ts.NewExpression, file: string, name: string): ts.ObjectLiteralExpression {
  const options = node.arguments?.[1];
  if (!options || !ts.isObjectLiteralExpression(options)) throw new Error(`${file}:${name}: literal options required`);
  return options;
}

function assertClassified(node: ts.NewExpression, file: string): void {
  const callee = node.expression.getText();
  if (!HOSTED_CONSTRUCTOR.test(callee) || resourceType(node.expression)) return;
  if (NOT_COVERED.some(entry => entry.shape === callee)) return;
  throw new Error(`${file}: unclassified hosted resource ${callee}; inventory it or list it in NOT_COVERED`);
}

/** Queue, Cron, EventRule, ReceiptRule, LogSubscriptionFilter, TopicSubscription and Service constructors. */
function discoverConstructorDeclarations(index: InfraIndex): {
  declarations: RawDeclaration[];
  byNode: Map<ts.NewExpression, RawDeclaration>;
  functions: { file: string; node: ts.NewExpression }[];
  eventTargets: { file: string; node: ts.NewExpression }[];
} {
  const declarations: RawDeclaration[] = [];
  const byNode = new Map<ts.NewExpression, RawDeclaration>();
  const functions: { file: string; node: ts.NewExpression }[] = [];
  const eventTargets: { file: string; node: ts.NewExpression }[] = [];
  const matchedDataNamed = new Map<(typeof DATA_NAMED_QUEUES)[number], number>();
  for (const source of index.parsed) {
    const file = source.fileName;
    walk(source, node => {
      if (!ts.isNewExpression(node)) return;
      assertClassified(node, file);
      const type = resourceType(node.expression);
      if (type === 'EventTarget') eventTargets.push({ file, node });
      if (type === 'Function') functions.push({ file, node });
      const kind = type && type !== 'Function' ? DECLARATION_KINDS[type] : undefined;
      if (!kind) return;
      const first = node.arguments?.[0];
      const dataNamed =
        kind === 'queue' && first && !ts.isStringLiteralLike(first)
          ? DATA_NAMED_QUEUES.find(entry => entry.file === file && entry.name === first.getText())
          : undefined;
      if (dataNamed) {
        matchedDataNamed.set(dataNamed, (matchedDataNamed.get(dataNamed) ?? 0) + 1);
        return;
      }
      const name = declarationName(node, file, kind);
      constructorOptions(node, file, name);
      const raw: RawDeclaration = { file, kind, name, nodes: [node], subscribers: [] };
      declarations.push(raw);
      byNode.set(node, raw);
    });
  }
  const parsedFiles = new Set(index.parsed.map(source => source.fileName));
  for (const entry of DATA_NAMED_QUEUES) {
    const matches = matchedDataNamed.get(entry) ?? 0;
    if (parsedFiles.has(entry.file) && matches === 0) {
      throw new Error(`${entry.file}: stale DATA_NAMED_QUEUES entry ${entry.name}; no queue is named by it`);
    }
    // One reviewed constructor per entry, so a second queue named the same way is not exempted.
    if (matches > 1) {
      throw new Error(`${entry.file}: DATA_NAMED_QUEUES entry ${entry.name} names ${matches} queues; it may name one`);
    }
  }
  return { declarations, byNode, functions, eventTargets };
}

function foldEventTargets(
  index: InfraIndex,
  byNode: Map<ts.NewExpression, RawDeclaration>,
  eventTargets: { file: string; node: ts.NewExpression }[]
): void {
  for (const { file, node } of eventTargets) {
    const name = declarationName(node, file, 'eventRule');
    const rule = property(constructorOptions(node, file, name), 'rule');
    const reference = rule ? unwrap(rule) : undefined;
    const receiver = reference && ts.isPropertyAccessExpression(reference) ? unwrap(reference.expression) : undefined;
    const target = receiver && ts.isIdentifier(receiver) ? index.resolve(file, receiver.text) : undefined;
    const owner = target?.type === 'EventRule' ? byNode.get(target.node) : undefined;
    if (!owner) throw new Error(`${file}:${name}: unresolved EventTarget rule ${rule?.getText() ?? '(none)'}`);
    owner.nodes.push(node);
  }
}

/** subscribe()/subscribeQueue()/notify() calls: folded into queues, or Bus/SNS/bucket declarations. */
function discoverMethodTriggers(index: InfraIndex, byNode: Map<ts.NewExpression, RawDeclaration>): RawDeclaration[] {
  const declarations: RawDeclaration[] = [];
  for (const source of index.parsed) {
    const file = source.fileName;
    walk(source, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text;
      if (!TRIGGER_METHODS.has(method)) return;
      const receiver = unwrap(node.expression.expression);
      const target = ts.isIdentifier(receiver) ? index.resolve(file, receiver.text) : undefined;
      if (!target) throw new Error(`${file}: unresolved subscription receiver ${receiver.getText()}`);
      const unsupported = () => new Error(`${file}: unsupported ${method}() on ${target.type} ${receiver.getText()}`);
      if (target.type === 'Queue') {
        const owner = byNode.get(target.node);
        if (method !== 'subscribe' || !owner) throw unsupported();
        owner.nodes.push(node);
        if (node.arguments[0]) owner.subscribers.push(node.arguments[0]);
      } else if (target.type === 'Bus') {
        if (method === 'notify') throw unsupported();
        const subscriber = node.arguments[1];
        declarations.push({
          file,
          kind: 'event',
          name: literal(node.arguments[0], file),
          nodes: [node],
          subscribers: subscriber && method === 'subscribe' ? [subscriber] : [],
        });
      } else if (target.type === 'SnsTopic') {
        if (method !== 'subscribe') throw unsupported();
        const name = literal(target.node.arguments?.[0], `${file}: SNS topic`);
        declarations.push({
          file,
          kind: 'snsSubscription',
          name,
          nodes: [node],
          subscribers: [...node.arguments.slice(0, 1)],
        });
      } else if (target.type === 'Bucket') {
        if (method !== 'notify') throw unsupported();
        declarations.push(...bucketNotifications(file, target, node));
      } else throw unsupported();
    });
  }
  return declarations;
}

function bucketNotifications(file: string, bucket: Resource, call: ts.CallExpression): RawDeclaration[] {
  const bucketName = literal(bucket.node.arguments?.[0], `${file}: bucket`);
  const options = call.arguments[0];
  const list = options && ts.isObjectLiteralExpression(options) ? property(options, 'notifications') : undefined;
  if (!list || !ts.isArrayLiteralExpression(list))
    throw new Error(`${file}:${bucketName}: literal notifications array required`);
  return list.elements.map(element => {
    if (!ts.isObjectLiteralExpression(element)) throw new Error(`${file}:${bucketName}: literal notification required`);
    const name = `${bucketName}.${literal(property(element, 'name'), `${file}:${bucketName} notification`)}`;
    return { file, kind: 'notification' as const, name, nodes: [element], subscribers: [] };
  });
}

/** Functions a declaration delivers to, via `<fn>.arn` in a TARGET_KEYS option or a subscriber argument. */
function targetFunctions(index: InfraIndex, raw: RawDeclaration): ts.NewExpression[] {
  const context = `${raw.file}:${raw.name}`;
  const found: ts.NewExpression[] = [];
  const add = (target: Resource | undefined) => {
    if (target?.type === 'Function' && !found.includes(target.node)) found.push(target.node);
  };
  for (const subscriber of raw.subscribers) add(index.arnTarget(raw.file, context, subscriber));
  for (const node of raw.nodes)
    walk(node, child => {
      if (!ts.isPropertyAssignment(child)) return;
      const key = propertyName(child) ?? '';
      if (!TARGET_KEYS.has(key)) return;
      const target = index.arnTarget(raw.file, `${context}: ${key}`, child.initializer);
      if (key === 'job' && target?.type !== 'Function' && !ts.isObjectLiteralExpression(child.initializer)) {
        if (target || ts.isPropertyAccessExpression(unwrap(child.initializer)))
          throw new Error(`${context}: unresolved scheduled job ${child.initializer.getText()}`);
        throw new Error(`${context}: unsupported scheduled job ${child.initializer.getText()}`);
      }
      add(target);
    });
  return found;
}

function declarationHandlers(raw: RawDeclaration, expanded: ts.Node[]): string[] {
  const inline = raw.subscribers.filter(ts.isStringLiteralLike).map(subscriber => subscriber.text);
  return [...new Set([...expanded.flatMap(handlerRefs), ...inline])].sort();
}

/**
 * The imported definition an identifier hashes as. `obj.key` on an imported object literal hashes
 * only that key's entry, so adding a sibling key (e.g. a new secret) does not invalidate every reader.
 */
function importedReference(index: InfraIndex, identifier: ts.Identifier): ts.Node | undefined {
  const definition = index.importedDefinition(identifier);
  const access = identifier.parent;
  if (
    !definition ||
    !ts.isVariableDeclaration(definition) ||
    !definition.initializer ||
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== identifier
  )
    return definition;
  const value = unwrap(definition.initializer);
  if (!ts.isObjectLiteralExpression(value)) return definition;
  const entry = value.properties.find(
    element =>
      (ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element)) &&
      propertyName(element) === access.name.text
  );
  return entry ?? definition;
}

function fingerprintDeclaration(
  index: InfraIndex,
  nodes: ts.Node[],
  targets: ts.Node[]
): { fingerprint: string; dependencies: ts.Node[] } {
  const expanded = [...nodes, ...targets];
  const dependencies = expanded.flatMap(node => referencedDefinitions(node.getSourceFile(), node));
  const gates = expanded.flatMap(ancestorGuards);
  const gateDefinitions = gates.flatMap(guard =>
    referencedDefinitions(guard.expression.getSourceFile(), guard.expression)
  );
  const imported: ts.Node[] = [];
  for (const node of [...expanded, ...dependencies, ...gates.map(guard => guard.expression), ...gateDefinitions])
    for (const identifier of parityReferences(node)) {
      const definition = importedReference(index, identifier);
      if (definition && !imported.includes(definition)) imported.push(definition);
    }
  const fingerprint = hash(
    [
      ...nodes.map(canonical),
      ...targets.map(canonical),
      ...dependencies.map(canonical),
      ...gates.map(guard => `${guard.branch}:${canonical(guard.expression)}`),
      ...gateDefinitions.map(canonical),
      ...imported.map(canonical),
    ].join('\n')
  );
  return { fingerprint, dependencies: [...dependencies, ...imported] };
}

function classifyAwsSignals(
  signalNodes: ts.Node[],
  handlerSources: HandlerSource[],
  parseHandler: (file: string) => ts.SourceFile
): string[] {
  const signals = signalNodes.flatMap(strings).filter(value => AWS_EXCLUSIVE.test(value));
  for (const { file, status } of handlerSources) {
    if (status !== 'found') continue;
    for (const statement of parseHandler(file).statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        AWS_EXCLUSIVE_SDK.test(statement.moduleSpecifier.text)
      )
        signals.push(`import:${statement.moduleSpecifier.text}`);
  }
  return [...new Set(signals)].sort();
}

/**
 * Static declarations only. Dynamic names/options and unresolved targets fail rather than
 * disappear from the inventory. Handler files absent from `sources` are reported per
 * declaration (`handlerSources`) and rejected by validateParityPolicy.
 */
export function discoverParityInventory(sources: Record<string, string>): ParityDeclaration[] {
  const index = new InfraIndex(
    Object.entries(sources)
      .filter(([file]) => file.startsWith('infra/'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, text]) => parse(file, text))
  );
  const { declarations, byNode, functions, eventTargets } = discoverConstructorDeclarations(index);
  foldEventTargets(index, byNode, eventTargets);
  const triggers = [...declarations, ...discoverMethodTriggers(index, byNode)];
  const parsedHandlers = new Map<string, ts.SourceFile>();
  const parseHandler = (file: string): ts.SourceFile => {
    const cached = parsedHandlers.get(file) ?? parse(file, sources[file]);
    parsedHandlers.set(file, cached);
    return cached;
  };
  const triggerTargets = new Set<ts.Node>();
  const build = (raw: RawDeclaration): ParityDeclaration => {
    const targets = targetFunctions(index, raw);
    for (const target of targets) triggerTargets.add(target);
    const expanded = [...raw.nodes, ...targets];
    const handlers = declarationHandlers(raw, expanded);
    const handlerSources = handlers.map((handler): HandlerSource => {
      const file = handlerFile(handler);
      if (Object.hasOwn(sources, file)) return { handler, file, status: 'found' };
      return { handler, file, status: file.startsWith(OVERLAY_GENERATED_HANDLER_DIR) ? 'overlayAbsent' : 'missing' };
    });
    const { fingerprint, dependencies } = fingerprintDeclaration(index, raw.nodes, targets);
    return {
      id: `${raw.kind}:${raw.file}:${raw.name}`,
      kind: raw.kind,
      name: raw.name,
      declaration: raw.nodes.map(canonical).join('\n'),
      fingerprint,
      handlers,
      handlerSources,
      hostedAwsSignals: classifyAwsSignals([...expanded, ...dependencies], handlerSources, parseHandler),
    };
  };
  const inventory = triggers.map(build);
  // Standalone Functions last: one that a trigger above delivers to is already inventoried there.
  for (const { file, node } of functions) {
    if (triggerTargets.has(node)) continue;
    const name = declarationName(node, file, 'function');
    if (property(constructorOptions(node, file, name), 'url')) continue; // NOT_COVERED: HTTP surface
    inventory.push(build({ file, kind: 'function', name, nodes: [node], subscribers: [] }));
  }
  const ids = inventory.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate hosted declaration identity');
  return inventory.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Local helpers that forward their first parameter as the name of a worker registration, e.g.
 * `const registerImageQueue = (name, ...) => worker.registerQueueHandler(name, ...)`.
 */
function registrationHelpers(source: ts.SourceFile): Map<string, 'queue' | 'schedule'> {
  const helpers = new Map<string, 'queue' | 'schedule'>();
  walk(source, node => {
    let name: string | undefined;
    let fn: ts.SignatureDeclaration | undefined;
    if (ts.isFunctionDeclaration(node) && node.name) [name, fn] = [node.name.text, node];
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      [name, fn] = [node.name.text, node.initializer];
    const parameter = fn?.parameters[0]?.name;
    if (!name || !fn || !parameter || !ts.isIdentifier(parameter)) return;
    walk(fn, child => {
      if (!ts.isCallExpression(child) || !ts.isPropertyAccessExpression(child.expression)) return;
      const kind = REGISTRATION_METHODS[child.expression.name.text];
      const first = child.arguments[0];
      if (kind && first && ts.isIdentifier(first) && first.text === parameter.text) helpers.set(name, kind);
    });
  });
  return helpers;
}

function registration(source: ts.SourceFile, symbol: string): ts.Node | undefined {
  const [kind, name] = symbol.split(':');
  const helpers = registrationHelpers(source);
  let found: ts.Node | undefined;
  walk(source, node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === symbol) found = node;
    if ((kind === 'queue' || kind === 'schedule') && ts.isCallExpression(node)) {
      const callee = node.expression;
      const registers = ts.isPropertyAccessExpression(callee)
        ? REGISTRATION_METHODS[callee.name.text] === kind
        : ts.isIdentifier(callee) && helpers.get(callee.text) === kind;
      const first = node.arguments[0];
      if (registers && first && ts.isStringLiteralLike(first) && first.text === name) found = node;
    }
    if (
      kind === 'event' &&
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteralLike(node.name) &&
      node.name.text === name
    )
      found = node;
  });
  return found;
}

export function portableRegistrationFingerprint(sourceText: string, symbol: string): string | undefined {
  const source = parse('portable.ts', sourceText);
  const node = registration(source, symbol);
  if (!node) return undefined;
  const guards = ancestorGuards(node).map(guard => `${guard.branch}:${canonical(guard.expression)}`);
  return hash(
    [
      ...source.statements.filter(ts.isImportDeclaration).map(canonical),
      canonical(node),
      ...referencedDefinitions(source, node).map(canonical),
      ...guards,
    ].join('\n')
  );
}

function reachable(sources: Record<string, string>, file: string, symbol: string): boolean {
  const main = sources[ENTRYPOINT];
  if (!main) return false;
  const source = parse(ENTRYPOINT, main);
  const boot = source.statements.find(
    statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'main'
  );
  if (!boot || !ts.isFunctionDeclaration(boot) || !boot.body) return false;
  const bootWalk = (node: ts.Node, visit: (node: ts.Node) => void): void => {
    if (ts.isFunctionDeclaration(node)) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const parent = node.parent;
      if (
        !ts.isCallExpression(parent) ||
        !ts.isPropertyAccessExpression(parent.expression) ||
        !Object.hasOwn(REGISTRATION_METHODS, parent.expression.name.text)
      )
        return;
    }
    visit(node);
    ts.forEachChild(node, child => bootWalk(child, visit));
  };
  if (file === ENTRYPOINT && /^(queue|schedule):/.test(symbol)) {
    const target = registration(source, symbol);
    let reached = false;
    bootWalk(boot.body, node => {
      if (node === target) reached = true;
    });
    return reached;
  }
  if (symbol.startsWith('event:')) symbol = 'dispatchSelfHostEvent';
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target =
      path.posix.normalize(path.posix.join(path.posix.dirname(ENTRYPOINT), statement.moduleSpecifier.text)) + '.ts';
    const bindings = statement.importClause?.namedBindings;
    if (target === file && bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements)
        if ((element.propertyName?.text ?? element.name.text) === symbol) names.add(element.name.text);
    }
  }
  let invoked = false;
  bootWalk(boot.body, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text))
      invoked = true;
  });
  return invoked;
}

export function portableImportCandidates(
  file: string,
  sourceText: string
): { specifier: string; candidates: string[] }[] {
  const aliases: Record<string, string> = {
    '@workers/': 'apps/workers/src/',
    '@server/': 'apps/client/server/',
    '@client/': 'apps/client/',
  };
  return parse(file, sourceText).statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const specifier = statement.moduleSpecifier.text;
    const alias = Object.keys(aliases).find(prefix => specifier.startsWith(prefix));
    const target = specifier.startsWith('.')
      ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
      : alias
        ? aliases[alias] + specifier.slice(alias.length)
        : undefined;
    if (!target) return [];
    return [
      {
        specifier,
        candidates: /\.[cm]?[jt]sx?$/.test(target)
          ? [target]
          : ['.ts', '.tsx', '.mts', '.mjs', '/index.ts'].map(extension => target + extension),
      },
    ];
  });
}

/**
 * Self-host files that register a queue/schedule under the hosted literal name. Only exact-name
 * matches are mechanical: a local registration under a different name, or an event route, is
 * invisible here and still relies on review.
 */
function localWiringFiles(sources: Record<string, string>): (item: ParityDeclaration) => string[] {
  const parsed = Object.entries(sources)
    .filter(([file]) => file.startsWith(SELFHOST_DIR) && /\.ts$/.test(file))
    .map(([file, text]) => parse(file, text));
  return item =>
    item.kind === 'queue' || item.kind === 'schedule'
      ? parsed.filter(source => registration(source, `${item.kind}:${item.name}`)).map(source => source.fileName)
      : [];
}

export function validateParityPolicy(
  inventory: ParityDeclaration[],
  policy: readonly ParityPolicyEntry[],
  sources: Record<string, string>
): string[] {
  const errors: string[] = [];
  const ids = new Set(inventory.map(item => item.id));
  const entries = new Map(policy.map(entry => [entry.id, entry]));
  const wiredLocally = localWiringFiles(sources);
  if (entries.size !== policy.length) errors.push('Duplicate policy entry');
  for (const entry of policy) if (!ids.has(entry.id)) errors.push(`Stale policy entry: ${entry.id}`);
  for (const item of inventory) {
    // The validator's sources are authoritative for presence, as for the portable import check.
    for (const { handler, file, status } of item.handlerSources)
      if (status === 'missing' && !Object.hasOwn(sources, file))
        errors.push(
          `Hosted handler source missing: ${item.id}: ${handler} (expected ${file}; AWS import scan skipped)`
        );
    const entry = entries.get(item.id);
    if (!entry) {
      errors.push(`Unreviewed declaration: ${item.id}`);
      errors.push(
        `Declaration snapshot: ${JSON.stringify({ id: item.id, fingerprint: item.fingerprint, hostedAwsSignals: item.hostedAwsSignals })}`
      );
      continue;
    }
    if (entry.fingerprint !== item.fingerprint) {
      errors.push(`Declaration changed: ${item.id}`);
      errors.push(`Declaration fingerprint after review: ${item.id}: ${item.fingerprint}`);
    }
    if (!/^Bike4Mind\/bike4mind#[1-9]\d*$/.test(entry.issue)) errors.push(`Tracked issue required: ${item.id}`);
    if (!entry.reason.trim()) errors.push(`Reason required: ${item.id}`);
    if (JSON.stringify(entry.hostedAwsSignals) !== JSON.stringify(item.hostedAwsSignals)) {
      errors.push(`AWS signals changed: ${item.id}`);
      errors.push(`AWS signals after review: ${item.id}: ${JSON.stringify(item.hostedAwsSignals)}`);
    }
    if (entry.disposition === 'pending')
      for (const file of wiredLocally(item)) errors.push(`Gap now has local wiring - review: ${item.id}: ${file}`);
    if (entry.disposition === 'portable') {
      const local = entry.portable;
      if (!local || !sources[local.source]) {
        errors.push(`Portable source missing: ${item.id}`);
        continue;
      }
      for (const dependency of portableImportCandidates(local.source, sources[local.source]))
        if (!dependency.candidates.some(candidate => Object.hasOwn(sources, candidate)))
          errors.push(`Portable import missing: ${item.id}: ${dependency.specifier}`);
      if (!reachable(sources, local.source, local.symbol))
        errors.push(`Portable registration not reachable: ${item.id}`);
      const fingerprint = portableRegistrationFingerprint(sources[local.source], local.symbol);
      if (!fingerprint || fingerprint !== local.fingerprint) {
        errors.push(`Portable registration changed: ${item.id}`);
        errors.push(`Portable fingerprint after review: ${item.id}: ${fingerprint ?? 'symbol missing'}`);
      }
    }
  }
  return errors;
}
