import ts from 'typescript';

export type ProviderSite = { id: string; file: string; owner: string; kind: string; callee: string; line: number };
export type ProviderEntry = {
  id: string;
  classification: 'metered' | 'forwarded' | 'debt';
  reason: string;
  witness?: string;
};
export type ProviderScan = { sites: ProviderSite[]; calls: Map<string, string[]> };

const FACTORIES = new Set(['getLlmByModel', 'getOperationsModel']);
const PROVIDERS: Record<string, string[]> = {
  openai: ['OpenAI', 'AzureOpenAI'],
  '@anthropic-ai/sdk': ['Anthropic'],
  '@aws-sdk/client-bedrock-runtime': ['BedrockRuntimeClient'],
  '@google/generative-ai': ['GoogleGenerativeAI'],
  '@google/genai': ['GoogleGenAI'],
};
const USAGE_BOUNDARIES = new Set([
  'meterCompletionBackend',
  'withMeteredCompletion',
  'meterEmailBackend',
  'recordOperationalUsage',
  'recordSessionOperationalUsage',
  'recordToolOperationalUsage',
  'recordEmailCompletionUsage',
  'recordUsageEvent',
  'recordToolUsageEvent',
  'settleCompletion',
]);
const PLATFORM_BOUNDARIES: Record<string, string> = {
  'b4m-core/services/src/sreAgentService/index.ts#SreAgentService/diagnose': 'new SreCompletionMeter',
  'b4m-core/services/src/billing/platformCompletionMeter.ts#PlatformCompletionMeter/complete':
    'this.context.accounting.settle',
};
const isUsageBoundary = (call: string, owner: string) =>
  USAGE_BOUNDARIES.has(call.split('.').at(-1) ?? '') ||
  /\.usageEvents\.record$/.test(call) ||
  PLATFORM_BOUNDARIES[owner] === call;

function ownerOf(node: ts.Node): string {
  const names: string[] = [];
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isClassDeclaration(parent)) {
      if (parent.name) names.unshift(parent.name.getText());
    } else if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      let holder = parent.parent;
      while (ts.isCallExpression(holder) || ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder))
        holder = holder.parent;
      if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) names.unshift(holder.name.getText());
    }
  }
  return names.join('/') || '<module>';
}

function expressionName(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isNewExpression(node)) return `new ${expressionName(node.expression)}`;
  if (ts.isPropertyAccessExpression(node)) return `${expressionName(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
    return `${expressionName(node.expression)}.${node.argumentExpression.text}`;
  }
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return expressionName(node.expression);
  return '';
}

// This is a syntactic backstop, not a cross-module data-flow or runtime billing proof.
export function scanProviderSources(sources: Record<string, string>): ProviderScan {
  const sites: ProviderSite[] = [];
  const calls = new Map<string, string[]>();
  for (const [file, source] of Object.entries(sources).sort()) {
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const aliases = new Map<string, string>();
    const sdkInstances = new Set<string>();
    const backendInstances = new Set<string>();
    const namespaces = new Map<string, string>();
    const imported = new Map<string, string>();
    const counts = new Map<string, number>();
    const walk = (node: ts.Node, visit: (node: ts.Node) => void) => {
      visit(node);
      ts.forEachChild(node, child => walk(child, visit));
    };
    walk(ast, node => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
      const moduleName = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause || clause.isTypeOnly) return;
      if (clause.name && PROVIDERS[moduleName]) imported.set(clause.name.text, PROVIDERS[moduleName][0]);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, moduleName);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (binding.isTypeOnly) continue;
          const name = (binding.propertyName ?? binding.name).text;
          if (
            FACTORIES.has(name) ||
            USAGE_BOUNDARIES.has(name) ||
            ['SreCompletionMeter', 'PlatformCompletionMeter'].includes(name) ||
            PROVIDERS[moduleName]?.includes(name)
          )
            imported.set(binding.name.text, name);
        }
      }
    });
    const memberKey = (name: string, node: ts.Node): string => {
      if (!name.startsWith('this.')) return name;
      let enclosing: ts.Node | undefined = node;
      while (enclosing && !ts.isClassDeclaration(enclosing) && !ts.isClassExpression(enclosing))
        enclosing = enclosing.parent;
      const className =
        enclosing && (ts.isClassDeclaration(enclosing) || ts.isClassExpression(enclosing))
          ? enclosing.name?.text
          : undefined;
      return `${className ?? '<class>'}::${name}`;
    };
    const canonicalName = (name: string, node: ts.Node, seen = new Set<string>()): string => {
      if (seen.has(name)) return name;
      seen.add(name);
      const parts = name.split('.');
      for (let length = parts.length; length > 0; length--) {
        const prefix = parts.slice(0, length).join('.');
        const alias = aliases.get(memberKey(prefix, node)) ?? imported.get(prefix);
        if (alias && alias !== prefix) return canonicalName([alias, ...parts.slice(length)].join('.'), node, seen);
      }
      const moduleName = namespaces.get(parts[0]);
      if (moduleName && (FACTORIES.has(parts[1]) || PROVIDERS[moduleName]?.includes(parts[1])))
        return parts.slice(1).join('.');
      return name;
    };
    const canonical = (node: ts.Expression): string => canonicalName(expressionName(node), node);
    const hasReceiver = (name: string, node: ts.Node, instances: Set<string>): boolean => {
      const key = memberKey(name, node);
      return [...instances].some(instance => key === instance || key.startsWith(`${instance}.`));
    };
    const bind = (name: string, init: ts.Expression, node: ts.Node) => {
      if (!name) return;
      const key = memberKey(name, node);
      if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) {
        aliases.set(key, canonical(init));
      }
      if (
        ts.isCallExpression(init) &&
        ts.isPropertyAccessExpression(init.expression) &&
        init.expression.name.text === 'bind'
      ) {
        aliases.set(key, canonical(init.expression.expression));
      }
      const value = ts.isAwaitExpression(init) ? init.expression : init;
      if (ts.isCallExpression(value) && FACTORIES.has(canonical(value.expression).split('.').at(-1) ?? ''))
        backendInstances.add(key);
      if (
        ts.isCallExpression(init) &&
        hasReceiver(canonical(init.expression), node, sdkInstances) &&
        /\.(?:getGenerativeModel|withOptions)$/.test(canonical(init.expression))
      )
        sdkInstances.add(key);
      if (ts.isNewExpression(init) && Object.values(PROVIDERS).flat().includes(canonical(init.expression)))
        sdkInstances.add(key);
    };
    for (let pass = 0; pass < 4; pass++) {
      walk(ast, node => {
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name))
          bind(node.name.text, node.initializer, node);
        else if (
          ts.isPropertyDeclaration(node) &&
          node.initializer &&
          (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) || ts.isStringLiteral(node.name))
        ) {
          bind(`this.${node.name.text}`, node.initializer, node);
          if (
            node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
            (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent)) &&
            node.parent.name
          )
            bind(`${node.parent.name.text}.${node.name.text}`, node.initializer, node);
        } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
          bind(expressionName(node.left), node.right, node);
      });
    }
    const hasInlineSdk = (expression: ts.Expression): boolean => {
      if (ts.isNewExpression(expression))
        return Object.values(PROVIDERS).flat().includes(canonical(expression.expression));
      if (
        ts.isPropertyAccessExpression(expression) ||
        ts.isElementAccessExpression(expression) ||
        ts.isParenthesizedExpression(expression) ||
        ts.isNonNullExpression(expression)
      )
        return hasInlineSdk(expression.expression);
      return false;
    };
    walk(ast, node => {
      if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
      const owner = ownerOf(node);
      const callee = canonical(node.expression);
      const tail = callee.split('.').at(-1) ?? '';
      const ownerKey = `${file}#${owner}`;
      const ownerCalls = calls.get(ownerKey) ?? [];
      ownerCalls.push(
        ts.isNewExpression(node) && ['SreCompletionMeter', 'PlatformCompletionMeter'].includes(callee)
          ? `new ${callee}`
          : callee
      );
      calls.set(ownerKey, ownerCalls);
      let kind: string | undefined;
      if (ts.isNewExpression(node) && Object.values(PROVIDERS).flat().includes(callee)) kind = 'sdk-constructor';
      else if (ts.isCallExpression(node) && FACTORIES.has(tail)) kind = 'factory';
      else if (
        ts.isCallExpression(node) &&
        tail === 'complete' &&
        (hasReceiver(callee, node, backendInstances) || /(?:llm|backend|adapters|context)/i.test(callee))
      )
        kind = 'completion';
      else if (
        ts.isCallExpression(node) &&
        (hasReceiver(callee, node, sdkInstances) || hasInlineSdk(node.expression)) &&
        /\.(?:create|stream|send|generateContent|generateContentStream)(?:\.(?:call|apply))?$/.test(callee)
      )
        kind = 'sdk-send';
      if (!kind) return;
      const key = `${ownerKey}#${kind}:${callee}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      sites.push({
        id: `${key}#${count}`,
        file,
        owner,
        kind,
        callee,
        line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    });
  }
  return { sites, calls };
}

export function parseProviderCatalog(text: string): ProviderEntry[] {
  return text
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => JSON.parse(line) as ProviderEntry);
}

export function validateProviderCatalog(scan: ProviderScan, entries: ProviderEntry[], base: ProviderEntry[]): string[] {
  const errors: string[] = [];
  const sites = new Map(scan.sites.map(site => [site.id, site]));
  const seen = new Set<string>();
  const baseForwardedPaid = new Set(
    base
      .filter(
        entry => ['debt', 'forwarded'].includes(entry.classification) && /#(?:completion|sdk-send):/.test(entry.id)
      )
      .map(entry => entry.id)
  );
  const baseDebt = new Set(base.filter(entry => entry.classification === 'debt').map(entry => entry.id));
  for (const entry of entries) {
    if (seen.has(entry.id)) errors.push(`Duplicate inventory entry: ${entry.id}`);
    seen.add(entry.id);
    const site = sites.get(entry.id);
    if (!site) {
      errors.push(`Stale inventory entry: ${entry.id}`);
      continue;
    }
    if (!entry.reason?.trim()) errors.push(`Missing reason: ${entry.id}`);
    if (!['metered', 'forwarded', 'debt'].includes(entry.classification))
      errors.push(`Invalid classification: ${entry.id}`);
    const localCalls = scan.calls.get(`${site.file}#${site.owner}`) ?? [];
    if (entry.classification === 'debt') {
      if (!baseDebt.has(entry.id)) errors.push(`Debt inventory grew: ${entry.id}`);
      if (localCalls.some(call => isUsageBoundary(call, `${site.file}#${site.owner}`)))
        errors.push(`Review newly wrapped debt: ${entry.id}`);
    } else {
      if (
        entry.classification === 'forwarded' &&
        ['completion', 'sdk-send'].includes(site.kind) &&
        !baseForwardedPaid.has(entry.id)
      )
        errors.push(`Forwarded paid-site inventory grew: ${entry.id}`);
      if (!entry.witness) {
        errors.push(`Missing boundary witness: ${entry.id}`);
        continue;
      }
      const separator = entry.witness.lastIndexOf('::');
      const scope = entry.witness.slice(0, separator);
      const call = entry.witness.slice(separator + 2);
      if (separator < 0 || !scan.calls.get(scope)?.includes(call)) errors.push(`Missing boundary call: ${entry.id}`);
      if (entry.classification === 'metered' && scope !== `${site.file}#${site.owner}`)
        errors.push(`Meter is outside call owner: ${entry.id}`);
      if (entry.classification === 'metered' && !isUsageBoundary(call, scope))
        errors.push(`Unknown metering boundary: ${entry.id}`);
    }
  }
  for (const site of scan.sites)
    if (!seen.has(site.id)) errors.push(`Unclassified provider site: ${site.id} (line ${site.line})`);
  return errors;
}
