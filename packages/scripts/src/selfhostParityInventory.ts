import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';

export interface ParityDeclaration {
  id: string;
  kind: 'queue' | 'schedule' | 'event';
  name: string;
  declaration: string;
  fingerprint: string;
  handlers: string[];
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

const AWS_EXCLUSIVE = /^(?:bedrock|events|lambda|cloudwatch|ssm|cognito-idp|dynamodb|execute-api):/;
const ENTRYPOINT = 'apps/workers/src/selfhost/main.ts';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function parse(file: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // Parse diagnostics are exposed on parsed files but not in the public SourceFile interface.
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error(`${file}: cannot parse declaration source`);
  return source;
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

/** Static declarations only. Dynamic names/options fail rather than disappear from inventory. */
export function discoverParityInventory(sources: Record<string, string>): ParityDeclaration[] {
  const parsed = Object.entries(sources)
    .filter(([file]) => file.startsWith('infra/'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, text]) => parse(file, text));
  const resources = new Map<string, { kind: string; file: string; node: ts.NewExpression }>();
  const aliases = new Map<string, string>();
  const imports: { key: string; target: string; name: string }[] = [];
  for (const source of parsed) {
    walk(source, node => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isNewExpression(node.initializer)
      ) {
        const kind = /^(?:sst\.aws\.(Queue|Bus|Function|Cron|SnsTopic)|aws\.sqs\.(Queue))$/
          .exec(node.initializer.expression.getText())
          ?.slice(1)
          .find(Boolean);
        if (kind)
          resources.set(`${source.fileName}:${node.name.text}`, {
            kind,
            file: source.fileName,
            node: node.initializer,
          });
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isConditionalExpression(node.initializer)
      ) {
        const choices = [node.initializer.whenTrue, node.initializer.whenFalse].filter(ts.isNewExpression);
        if (choices.length > 1) throw new Error(`${source.fileName}: ambiguous resource ${node.name.text}`);
        const choice = choices[0];
        const kind = choice
          ? /^sst\.aws\.(Queue|Bus|Function|Cron|SnsTopic)$/.exec(choice.expression.getText())?.[1]
          : undefined;
        if (kind) resources.set(`${source.fileName}:${node.name.text}`, { kind, file: source.fileName, node: choice });
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) &&
        ts.isNewExpression(node.right)
      ) {
        const kind = /^sst\.aws\.(Queue|Bus|Function|Cron|SnsTopic)$/.exec(node.right.expression.getText())?.[1];
        if (kind)
          resources.set(`${source.fileName}:${node.left.text}`, { kind, file: source.fileName, node: node.right });
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer)
      )
        aliases.set(`${source.fileName}:${node.name.text}`, `${source.fileName}:${node.initializer.text}`);
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith('.')
      ) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            imports.push({
              key: `${source.fileName}:${element.name.text}`,
              target:
                path.posix.normalize(path.posix.join(path.posix.dirname(source.fileName), node.moduleSpecifier.text)) +
                '.ts',
              name: element.propertyName?.text ?? element.name.text,
            });
          }
        }
      }
    });
  }
  for (const imported of imports) aliases.set(imported.key, `${imported.target}:${imported.name}`);
  const resource = (file: string, name: string) => {
    let key = `${file}:${name}`;
    const seen = new Set<string>();
    while (aliases.has(key) && !seen.has(key)) {
      seen.add(key);
      key = aliases.get(key)!;
    }
    return resources.get(key);
  };
  const subscriptions = new Map<ts.NewExpression, ts.CallExpression[]>();
  const events: { file: string; node: ts.CallExpression }[] = [];
  for (const source of parsed) {
    walk(source, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const method = node.expression.name.text;
      if (method !== 'subscribe' && method !== 'subscribeQueue') return;
      let receiver: ts.Expression = node.expression.expression;
      while (ts.isNonNullExpression(receiver) || ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
      const target = ts.isIdentifier(receiver) ? resource(source.fileName, receiver.text) : undefined;
      if (!target) throw new Error(`${source.fileName}: unresolved subscription receiver ${receiver.getText()}`);
      // SNS alarm subscriptions are infrastructure notifications outside the queue/Bus inventory.
      if (target.kind === 'SnsTopic') return;
      if (target?.kind === 'Bus') events.push({ file: source.fileName, node });
      else if (target?.kind === 'Queue')
        subscriptions.set(target.node, [...(subscriptions.get(target.node) ?? []), node]);
    });
  }
  const inventory: ParityDeclaration[] = [];
  const add = (file: string, kind: ParityDeclaration['kind'], name: string, nodes: ts.Node[]) => {
    const declaration = nodes.map(canonical).join('\n');
    const expanded = [...nodes];
    if (
      kind === 'event' &&
      ts.isCallExpression(nodes[0]) &&
      ts.isPropertyAccessExpression(nodes[0].arguments[1]) &&
      ts.isIdentifier(nodes[0].arguments[1].expression)
    ) {
      const target = resource(file, nodes[0].arguments[1].expression.text);
      if (!target || target.kind !== 'Function') throw new Error(`${file}:${name}: unresolved event function target`);
      expanded.push(target.node);
    }
    const handlers = expanded.flatMap(handlerRefs);
    // Cron job ARN references retain their source expression and referenced Function definition.
    for (const node of nodes) {
      walk(node, child => {
        if (!ts.isPropertyAssignment(child) || child.name.getText() !== 'job') return;
        const expr = child.initializer;
        if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
          const target = resource(file, expr.expression.text);
          if (!target || target.kind !== 'Function')
            throw new Error(`${file}:${name}: unresolved scheduled job ${expr.getText()}`);
          handlers.push(...handlerRefs(target.node));
          expanded.push(target.node);
        } else if (!ts.isObjectLiteralExpression(expr))
          throw new Error(`${file}:${name}: unsupported scheduled job ${expr.getText()}`);
      });
    }
    const jobDefinitions: string[] = [];
    for (const node of nodes)
      walk(node, child => {
        if (
          ts.isPropertyAssignment(child) &&
          child.name.getText() === 'job' &&
          ts.isPropertyAccessExpression(child.initializer) &&
          ts.isIdentifier(child.initializer.expression)
        ) {
          const target = resource(file, child.initializer.expression.text);
          if (target) jobDefinitions.push(canonical(target.node));
        }
      });
    const hostedAwsSignals = [...new Set(expanded.flatMap(strings).filter(value => AWS_EXCLUSIVE.test(value)))];
    for (const handler of handlers) {
      const handlerFile = handler.slice(0, handler.lastIndexOf('.')) + '.ts';
      if (!sources[handlerFile]) continue;
      for (const statement of parse(handlerFile, sources[handlerFile]).statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          /^@aws-sdk\/client-(?:bedrock(?:-runtime|-agent-runtime)?|eventbridge|lambda|cloudwatch(?:-logs)?|ssm|cognito-identity-provider|dynamodb)$/.test(
            statement.moduleSpecifier.text
          )
        )
          hostedAwsSignals.push(`import:${statement.moduleSpecifier.text}`);
      }
    }
    const dependencyNodes = expanded.flatMap(node => referencedDefinitions(node.getSourceFile(), node));
    const gates = expanded.flatMap(node => ancestorGuards(node));
    const gateDefinitions = gates.flatMap(node =>
      referencedDefinitions(node.expression.getSourceFile(), node.expression)
    );
    const importedDefinitions: ts.Node[] = [];
    const variables = new Map<string, ts.VariableDeclaration>();
    for (const source of parsed)
      walk(source, node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name))
          variables.set(`${source.fileName}:${node.name.text}`, node);
      });
    for (const node of [...expanded, ...dependencyNodes, ...gates.map(guard => guard.expression), ...gateDefinitions])
      walk(node, child => {
        if (!ts.isIdentifier(child)) return;
        const target = aliases.get(`${child.getSourceFile().fileName}:${child.text}`);
        const definition = target ? variables.get(target) : undefined;
        if (definition && !importedDefinitions.includes(definition)) importedDefinitions.push(definition);
      });
    hostedAwsSignals.push(
      ...[...dependencyNodes, ...importedDefinitions].flatMap(strings).filter(value => AWS_EXCLUSIVE.test(value))
    );
    inventory.push({
      id: `${kind}:${file}:${name}`,
      kind,
      name,
      declaration,
      fingerprint: hash(
        [
          declaration,
          ...jobDefinitions,
          ...expanded.slice(nodes.length).map(canonical),
          ...dependencyNodes.map(canonical),
          ...gates.map(guard => `${guard.branch}:${canonical(guard.expression)}`),
          ...gateDefinitions.map(canonical),
          ...importedDefinitions.map(canonical),
        ].join('\n')
      ),
      handlers: [...new Set(handlers)].sort(),
      hostedAwsSignals: [...new Set(hostedAwsSignals)].sort(),
    });
  };
  for (const source of parsed) {
    walk(source, node => {
      if (!ts.isNewExpression(node)) return;
      const kind = /^(?:sst\.aws\.(Queue|Cron)|aws\.sqs\.(Queue))$/
        .exec(node.expression.getText())
        ?.slice(1)
        .find(Boolean);
      if (!kind) return;
      const name = literal(node.arguments?.[0], source.fileName);
      if (!node.arguments?.[1] || !ts.isObjectLiteralExpression(node.arguments[1]))
        throw new Error(`${source.fileName}:${name}: literal options required`);
      add(source.fileName, kind === 'Queue' ? 'queue' : 'schedule', name, [node, ...(subscriptions.get(node) ?? [])]);
    });
  }
  for (const { file, node } of events) add(file, 'event', literal(node.arguments[0], file), [node]);
  const ids = inventory.map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate hosted declaration identity');
  return inventory.sort((a, b) => a.id.localeCompare(b.id));
}

function ancestorGuards(node: ts.Node): { expression: ts.Expression; branch: 'true' | 'false' }[] {
  const guards: { expression: ts.Expression; branch: 'true' | 'false' }[] = [];
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isIfStatement(parent) && child !== parent.expression)
      guards.push({ expression: parent.expression, branch: child === parent.thenStatement ? 'true' : 'false' });
    if (ts.isConditionalExpression(parent) && child !== parent.condition)
      guards.push({ expression: parent.condition, branch: child === parent.whenTrue ? 'true' : 'false' });
  }
  return guards;
}

function registration(source: ts.SourceFile, symbol: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  walk(source, node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === symbol) found = node;
    const [kind, name] = symbol.split(':');
    if (
      (kind === 'queue' || kind === 'schedule') &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['registerQueueHandler', 'registerScheduledTask', 'registerDailyUtcTask'].includes(node.expression.name.text) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === name
    )
      found = node;
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

function referencedDefinitions(source: ts.SourceFile, node: ts.Node): ts.Node[] {
  const declarations = new Map<string, ts.VariableDeclaration>();
  walk(source, child => {
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name)) declarations.set(child.name.text, child);
  });
  const found = new Set<ts.Node>();
  const collect = (current: ts.Node): void =>
    walk(current, child => {
      if (!ts.isIdentifier(child)) return;
      const declaration = declarations.get(child.text);
      if (declaration && declaration !== node && !found.has(declaration)) {
        found.add(declaration);
        collect(declaration);
      }
    });
  collect(node);
  return [...found].sort((a, b) => a.pos - b.pos);
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
        !['registerQueueHandler', 'registerScheduledTask', 'registerDailyUtcTask'].includes(parent.expression.name.text)
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

export function validateParityPolicy(
  inventory: ParityDeclaration[],
  policy: readonly ParityPolicyEntry[],
  sources: Record<string, string>
): string[] {
  const errors: string[] = [];
  const ids = new Set(inventory.map(item => item.id));
  const entries = new Map(policy.map(entry => [entry.id, entry]));
  if (entries.size !== policy.length) errors.push('Duplicate policy entry');
  for (const entry of policy) if (!ids.has(entry.id)) errors.push(`Stale policy entry: ${entry.id}`);
  for (const item of inventory) {
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
    if (entry.disposition === 'portable') {
      const local = entry.portable;
      if (!local || !sources[local.source]) {
        errors.push(`Portable source missing: ${item.id}`);
        continue;
      }
      for (const dependency of portableImportCandidates(local.source, sources[local.source]))
        if (!dependency.candidates.some(candidate => Object.hasOwn(sources, candidate)))
          errors.push(`Portable import missing: ${item.id}: ${dependency.specifier}`);
      for (const handler of item.handlers) {
        const handlerFile = handler.slice(0, handler.lastIndexOf('.')) + '.ts';
        if (!Object.hasOwn(sources, handlerFile))
          errors.push(`Portable hosted handler missing: ${item.id}: ${handler}`);
      }
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
