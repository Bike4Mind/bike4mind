/**
 * Static inventory of the `apps/client/pages/api` routes: per route its methods, auth mode, API-key
 * scopes, whether a public contract serves it, and which `apps/client/app` files call it. Pure
 * functions over source text so the analysis is testable without the repo on disk; the CLI that
 * reads the tree and writes docs/api-route-inventory.md is generateApiRouteInventory.ts.
 *
 * Signals mirror the runtime: auth and scopes come from the `baseApi({ auth, requiredScopes })`
 * options (apps/client/server/middlewares/baseApi.ts), and a contracted route's from its OpenAPI
 * operation, because nextRouteForContract derives both from the contract
 * (apps/client/server/middlewares/defineNextRoute.ts).
 */
import path from 'node:path';
import ts from 'typescript';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * `jwt+key`: session JWT or API key (baseApi's default). `jwt`: `auth: 'jwtOnly'`. `optional`:
 * `auth: false` plus optionalAuth, so a session is read but not required. `handler`: no session or
 * API-key gate (`auth: false`, a public contract, or no baseApi at all); whatever check exists is in
 * the handler (shared secret, webhook signature) or there is none, which static analysis cannot tell
 * apart. `unknown`: an options shape the analyzer cannot read statically.
 */
export type AuthMode = 'jwt+key' | 'jwt' | 'optional' | 'handler' | 'unknown';

/** Verbs that share one scope list, used when a route's verbs require different scopes. */
export type MethodScopes = { methods: HttpMethod[]; scopes: string[] };

export type RouteAnalysis = {
  methods: HttpMethod[];
  /** True when no verb filter was found: a `.use()`-only router or a raw handler that never checks req.method. */
  acceptsAnyMethod: boolean;
  auth: AuthMode[];
  /** Union over all verbs; `methodScopes` breaks it down when the verbs disagree. */
  scopes: string[];
  methodScopes?: MethodScopes[];
  contracted: boolean;
};

export type RouteRecord = RouteAnalysis & {
  route: string;
  file: string;
  /** Route whose handler this file re-exports; the analysis fields describe that handler. */
  aliasOf?: string;
  callers: string[];
};

export type ContractOperation = { method: HttpMethod; auth: AuthMode; scopes: string[] };

/** Contract operations keyed by `normalizeRouteKey` of their OpenAPI path. */
export type ContractIndex = Map<string, ContractOperation[]>;

/** Resolves `ApiKeyScope.X` members and named scope arrays (e.g. PROJECTS_READ_SCOPES) to scope strings. */
export type ScopeTable = {
  enumValues: ReadonlyMap<string, string>;
  arrays: ReadonlyMap<string, ts.Expression>;
};

const ROUTE_FILE_PATTERN = /\.(ts|tsx)$/;
const OPTIONAL_AUTH_PATTERN = /\b(optionalAuth|optionalJwtAuth)\b/;

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const isHttpMethod = (value: string): value is HttpMethod => (HTTP_METHODS as readonly string[]).includes(value);

const sortMethods = (methods: Iterable<HttpMethod>): HttpMethod[] =>
  [...new Set(methods)].sort((a, b) => HTTP_METHODS.indexOf(a) - HTTP_METHODS.indexOf(b));

/** `apps/client/pages/api/sessions/[id]/index.ts` -> `/api/sessions/[id]`, or null for non-routes. */
export function routeFromFile(file: string): string | null {
  const match = /(?:^|\/)pages(\/api\/.*)$/.exec(file);
  if (!match || !ROUTE_FILE_PATTERN.test(file)) return null;
  if (isTestFile(file)) return null;
  const withoutExtension = match[1].replace(ROUTE_FILE_PATTERN, '');
  return withoutExtension.replace(/\/index$/, '') || '/api';
}

export function isTestFile(file: string): boolean {
  return /(^|\/)__tests__\//.test(file) || /\.test\.(ts|tsx)$/.test(file);
}

/** Collapses every dynamic segment so `/api/files/{id}` and `/api/files/[file_id]` share a key. */
export function normalizeRouteKey(route: string): string {
  return route.replace(/\{[^}]+\}|\[[^\]]+\]/g, '{}');
}

export function buildScopeTable(sources: Record<string, string>): ScopeTable {
  const enumValues = new Map<string, string>();
  const arrays = new Map<string, ts.Expression>();
  for (const [fileName, text] of Object.entries(sources)) {
    const sourceFile = parse(fileName, text);
    collectScopeEnum(sourceFile, enumValues);
    collectTopLevelArrays(sourceFile, arrays);
  }
  return { enumValues, arrays };
}

function collectScopeEnum(sourceFile: ts.SourceFile, into: Map<string, string>): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isEnumDeclaration(statement) || statement.name.text !== 'ApiKeyScope') continue;
    for (const member of statement.members) {
      if (member.initializer && ts.isStringLiteral(member.initializer)) {
        into.set(member.name.getText(sourceFile), member.initializer.text);
      }
    }
  }
}

function collectTopLevelObjects(sourceFile: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (ts.isObjectLiteralExpression(initializer)) objects.set(declaration.name.text, initializer);
    }
  }
  return objects;
}

function collectTopLevelArrays(sourceFile: ts.SourceFile, into: Map<string, ts.Expression>): void {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrap(declaration.initializer);
      if (ts.isArrayLiteralExpression(initializer)) into.set(declaration.name.text, initializer);
    }
  }
}

/** Unresolvable elements are kept as `?NAME` so a gap is visible in the table rather than dropped. */
function resolveScopes(expression: ts.Expression, table: ScopeTable, seen: ReadonlySet<string> = new Set()): string[] {
  const node = unwrap(expression);
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap(element =>
      ts.isSpreadElement(element) ? resolveScopes(element.expression, table, seen) : resolveScopes(element, table, seen)
    );
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'ApiKeyScope'
  ) {
    return [table.enumValues.get(node.name.text) ?? `?ApiKeyScope.${node.name.text}`];
  }
  if (ts.isStringLiteral(node)) return [node.text];
  if (ts.isIdentifier(node)) {
    const target = table.arrays.get(node.text);
    if (!target || seen.has(node.text)) return [`?${node.text}`];
    return resolveScopes(target, table, new Set([...seen, node.text]));
  }
  return [`?${node.getText()}`];
}

/** Walks `a(...).b(...).c` back to its leftmost identifier. */
function chainRoot(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  for (;;) {
    current = unwrap(current);
    if (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else if (ts.isIdentifier(current)) {
      return current.text;
    } else {
      return null;
    }
  }
}

const ROUTER_FACTORIES = new Set(['baseApi', 'nextRouteForContract']);

/** Names bound (directly or through another bound name) to a baseApi/nextRouteForContract chain. */
function routerBindings(sourceFile: ts.SourceFile): Set<string> {
  const declarations: Array<{ name: string; root: string }> = [];
  visit(sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const root = chainRoot(node.initializer);
      if (root) declarations.push({ name: node.name.text, root });
    }
  });
  const bound = new Set(ROUTER_FACTORIES);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, root } of declarations) {
      if (bound.has(root) && !bound.has(name)) {
        bound.add(name);
        changed = true;
      }
    }
  }
  return bound;
}

type BaseApiOptions = { auth: AuthMode; scopes: string[] };

type OptionsContext = {
  table: ScopeTable;
  objects: ReadonlyMap<string, ts.ObjectLiteralExpression>;
  optionalAuth: boolean;
};

function readBaseApiOptions(call: ts.CallExpression, { table, objects, optionalAuth }: OptionsContext): BaseApiOptions {
  const [argument] = call.arguments;
  if (!argument) return { auth: 'jwt+key', scopes: [] };
  const unwrapped = unwrap(argument);
  const options = ts.isIdentifier(unwrapped) ? objects.get(unwrapped.text) : unwrapped;
  if (!options || !ts.isObjectLiteralExpression(options)) return { auth: 'unknown', scopes: [] };

  let auth: AuthMode = 'jwt+key';
  let scopes: string[] = [];
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) {
      auth = 'unknown';
    } else if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === 'auth') auth = 'unknown';
      if (property.name.text === 'requiredScopes') scopes = resolveScopes(property.name, table);
    } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      if (property.name.text === 'auth') auth = readAuthOption(unwrap(property.initializer), optionalAuth);
      if (property.name.text === 'requiredScopes') scopes = resolveScopes(property.initializer, table);
    }
  }
  return { auth, scopes };
}

function readAuthOption(value: ts.Expression, optionalAuth: boolean): AuthMode {
  if (value.kind === ts.SyntaxKind.FalseKeyword) return optionalAuth ? 'optional' : 'handler';
  if (value.kind === ts.SyntaxKind.TrueKeyword) return 'jwt+key';
  if (ts.isStringLiteral(value) && value.text === 'jwtOnly') return 'jwt';
  return 'unknown';
}

function dispatchedMethods(call: ts.CallExpression): HttpMethod[] {
  const argument = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  if (!argument || !ts.isObjectLiteralExpression(argument)) return [];
  const methods: HttpMethod[] = [];
  for (const property of argument.properties) {
    const name = property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
    if (name && isHttpMethod(name)) methods.push(name);
  }
  return methods;
}

/**
 * The relative module and binding a route file re-exports as its default
 * (`export { default } from '../v1/quests/[id]'`), or null when the file defines its own handler.
 */
export function reexportedDefault(fileName: string, text: string): { specifier: string; exportName: string } | null {
  const sourceFile = parse(fileName, text);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue;
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    const element = statement.exportClause.elements.find(candidate => candidate.name.text === 'default');
    if (element) {
      return { specifier: statement.moduleSpecifier.text, exportName: element.propertyName?.text ?? 'default' };
    }
  }
  return null;
}

/**
 * The nodes that build a named router: its declaration plus the declarations its chain starts from
 * (`const base = baseApi(...)` behind `export const r = base.post(...)`).
 */
function namedRouterNodes(sourceFile: ts.SourceFile, exportName: string): ts.Node[] | null {
  const initializers = new Map<string, ts.Expression>();
  visit(sourceFile, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
  });
  const nodes: ts.Node[] = [];
  let name: string | null = exportName;
  while (name && initializers.has(name) && nodes.length <= initializers.size) {
    const initializer = initializers.get(name) as ts.Expression;
    nodes.push(initializer);
    name = chainRoot(initializer);
  }
  return nodes.length > 0 ? nodes : null;
}

const isMethodAccess = (node: ts.Expression) =>
  ts.isPropertyAccessExpression(unwrap(node)) && (unwrap(node) as ts.PropertyAccessExpression).name.text === 'method';

const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function stringElements(expression: ts.Expression, arrays: ReadonlyMap<string, ts.Expression>): string[] {
  const node = unwrap(expression);
  const array = ts.isIdentifier(node) ? arrays.get(node.text) : node;
  if (!array || !ts.isArrayLiteralExpression(unwrap(array))) return [];
  return (unwrap(array) as ts.ArrayLiteralExpression).elements.flatMap(element =>
    ts.isStringLiteral(element) ? [element.text] : []
  );
}

/**
 * Verbs a raw handler compares `req.method` against: `req.method === 'POST'`, `switch (req.method)`
 * cases, and `[...].includes(req.method)`. Method strings elsewhere (comments, outbound fetches)
 * do not count.
 */
function rawMethodChecks(sourceFile: ts.SourceFile, arrays: ReadonlyMap<string, ts.Expression>): HttpMethod[] {
  const found: string[] = [];
  visit(sourceFile, node => {
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      const [access, literal] = isMethodAccess(node.left) ? [node.left, node.right] : [node.right, node.left];
      if (isMethodAccess(access) && ts.isStringLiteral(unwrap(literal)))
        found.push((unwrap(literal) as ts.StringLiteral).text);
    } else if (ts.isSwitchStatement(node) && isMethodAccess(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) found.push(clause.expression.text);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && isMethodAccess(node.arguments[0])) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'includes') {
        found.push(...stringElements(callee.expression, arrays));
      }
    }
  });
  return found.map(method => method.toUpperCase()).filter(isHttpMethod);
}

/** `export default someFactory(...)`: the handler, and any method check, lives in imported code. */
function exportsBuiltHandler(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    statement => ts.isExportAssignment(statement) && ts.isCallExpression(unwrap(statement.expression))
  );
}

/**
 * Analyzes one route file. `contracts` supplies auth and scopes for verbs a contract serves.
 * `exportName` narrows the analysis to one named router when an alias re-exports it.
 */
export function analyzeRouteSource(
  fileName: string,
  text: string,
  route: string,
  table: ScopeTable,
  contracts: ContractIndex,
  exportName = 'default'
): RouteAnalysis {
  const sourceFile = parse(fileName, text);
  const fileArrays = new Map(table.arrays);
  collectTopLevelArrays(sourceFile, fileArrays);
  const context: OptionsContext = {
    table: { enumValues: table.enumValues, arrays: fileArrays },
    objects: collectTopLevelObjects(sourceFile),
    optionalAuth: OPTIONAL_AUTH_PATTERN.test(text),
  };
  const scopeNodes = (exportName !== 'default' && namedRouterNodes(sourceFile, exportName)) || [sourceFile];

  const bindings = routerBindings(sourceFile);
  const methods = new Set<HttpMethod>();
  const auth = new Set<AuthMode>();
  const scopes = new Set<string>();
  let usesRouter = false;
  let contracted = false;
  let methodsKnown = true;

  const inspect = (node: ts.Node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee)) {
      if (callee.text === 'baseApi') {
        usesRouter = true;
        const options = readBaseApiOptions(node, context);
        auth.add(options.auth);
        options.scopes.forEach(scope => scopes.add(scope));
      } else if (callee.text === 'nextRouteForContract') {
        usesRouter = true;
        contracted = true;
      } else if (callee.text === 'dispatchByMethod') {
        dispatchedMethods(node).forEach(method => methods.add(method));
      }
      return;
    }
    if (!ts.isPropertyAccessExpression(callee)) return;
    const verb = callee.name.text.toUpperCase();
    const root = chainRoot(callee.expression);
    if (isHttpMethod(verb) && root && bindings.has(root)) methods.add(verb);
  };
  scopeNodes.forEach(node => visit(node, inspect));

  if (!usesRouter) {
    rawMethodChecks(sourceFile, fileArrays).forEach(method => methods.add(method));
    methodsKnown = methods.size > 0 || !exportsBuiltHandler(sourceFile);
    auth.add('handler');
  }

  const methodScopes = contracted ? applyContractOperations(route, methods, auth, scopes, contracts) : undefined;

  return {
    methods: sortMethods(methods),
    acceptsAnyMethod: methods.size === 0 && methodsKnown,
    auth: [...auth].sort(),
    scopes: [...scopes].sort(),
    ...(methodScopes && { methodScopes }),
    contracted,
  };
}

/**
 * A contracted router's auth and scopes live on the contract, not in the route file, so they are
 * read from the matching OpenAPI operation. A verb with no operation keeps the file-level reading.
 * Returns the per-verb scopes when the served operations disagree, so a read scope is never shown
 * as admitting a write.
 */
function applyContractOperations(
  route: string,
  methods: Set<HttpMethod>,
  auth: Set<AuthMode>,
  scopes: Set<string>,
  contracts: ContractIndex
): MethodScopes[] | undefined {
  const operations = contracts.get(normalizeRouteKey(route)) ?? [];
  const served = methods.size > 0 ? operations.filter(operation => methods.has(operation.method)) : operations;
  if (served.length === 0) {
    if (auth.size === 0) auth.add('unknown');
    return undefined;
  }
  for (const operation of served) {
    methods.add(operation.method);
    auth.add(operation.auth);
    operation.scopes.forEach(scope => scopes.add(scope));
  }
  return groupScopesByMethod(served);
}

function groupScopesByMethod(operations: readonly ContractOperation[]): MethodScopes[] | undefined {
  const groups = new Map<string, MethodScopes>();
  for (const operation of operations) {
    const key = operation.scopes.join(',');
    const group = groups.get(key) ?? { methods: [], scopes: operation.scopes };
    group.methods = sortMethods([...group.methods, operation.method]);
    groups.set(key, group);
  }
  if (groups.size < 2) return undefined;
  return [...groups.values()].sort((a, b) => HTTP_METHODS.indexOf(a.methods[0]) - HTTP_METHODS.indexOf(b.methods[0]));
}

type OpenApiOperation = { security?: Array<Record<string, unknown>>; 'x-required-scopes'?: string[] };
type OpenApiDocument = { paths?: Record<string, Record<string, OpenApiOperation>> };

/** Builds the contract index from the generated OpenAPI document (apps/client/public/openapi.json). */
export function contractIndexFromOpenApi(document: OpenApiDocument): ContractIndex {
  const index: ContractIndex = new Map();
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      const verb = method.toUpperCase();
      if (!isHttpMethod(verb)) continue;
      const key = normalizeRouteKey(path);
      const entry: ContractOperation = {
        method: verb,
        auth: authFromSecurity(operation.security),
        scopes: [...(operation['x-required-scopes'] ?? [])].sort(),
      };
      index.set(key, [...(index.get(key) ?? []), entry]);
    }
  }
  return index;
}

function authFromSecurity(security: OpenApiOperation['security']): AuthMode {
  if (!security || security.length === 0) return 'handler';
  const schemes = new Set(security.flatMap(requirement => Object.keys(requirement)));
  return schemes.has('apiKeyAuth') ? 'jwt+key' : 'jwt';
}

/** A caller path split into segments; `null` marks a segment built from an interpolated value. */
export type CallerPath = Array<string | null>;

/**
 * Every `/api/...` path a client file names, from string literals, template literals and `+`
 * concatenation. A template that starts with a same-file string constant (`${BASE}/${id}`) is
 * resolved through that constant.
 */
export function extractApiPaths(fileName: string, text: string): CallerPath[] {
  if (!text.includes('/api')) return [];
  const sourceFile = parse(fileName, text);
  const constants = stringConstants(sourceFile);
  const paths: CallerPath[] = [];
  visit(sourceFile, node => {
    if (ts.isBinaryExpression(node) && ts.isBinaryExpression(node.parent) && node.parent.left === node) return;
    const pieces = literalPieces(node, constants);
    if (!pieces) return;
    const path = toCallerPath(pieces);
    if (path) paths.push(path);
  });
  return paths;
}

type Piece = string | null;

function stringConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  visit(sourceFile, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    const initializer = unwrap(node.initializer);
    if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
      constants.set(node.name.text, initializer.text);
    }
  });
  return constants;
}

/** Flattens a string-building expression into text pieces, `null` standing in for runtime values. */
function literalPieces(node: ts.Node, constants: ReadonlyMap<string, string>): Piece[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return isPartOfConcatenation(node) ? null : [node.text];
  }
  if (ts.isTemplateExpression(node)) {
    const pieces: Piece[] = [node.head.text];
    for (const span of node.templateSpans) {
      const expression = unwrap(span.expression);
      const constant = ts.isIdentifier(expression) ? constants.get(expression.text) : undefined;
      pieces.push(constant ?? null, span.literal.text);
    }
    return dropEmptyHead(pieces);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return concatenationPieces(node, constants);
  }
  return null;
}

function isPartOfConcatenation(node: ts.Node): boolean {
  return ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

function concatenationPieces(node: ts.Expression, constants: ReadonlyMap<string, string>): Piece[] {
  const expression = unwrap(node);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...concatenationPieces(expression.left, constants), ...concatenationPieces(expression.right, constants)];
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isIdentifier(expression) && constants.has(expression.text)) return [constants.get(expression.text) ?? null];
  return [null];
}

function dropEmptyHead(pieces: Piece[]): Piece[] {
  return pieces.filter((piece, position) => !(position === 0 && piece === ''));
}

function toCallerPath(pieces: Piece[]): CallerPath | null {
  const [first] = pieces;
  if (typeof first !== 'string' || !/^\/api(\/|$|\?)/.test(first)) return null;

  const segments: CallerPath = [];
  let current = '';
  let dynamic = false;
  for (const piece of pieces) {
    // A value glued onto a static segment (`/api/files${query}`) is a query suffix, not a segment.
    if (piece === null && current !== '' && !dynamic) break;
    if (piece === null) {
      dynamic = true;
      continue;
    }
    const queryAt = piece.search(/[?#]/);
    const text = queryAt === -1 ? piece : piece.slice(0, queryAt);
    const parts = text.split('/');
    parts.forEach((part, position) => {
      if (position > 0) {
        segments.push(dynamic ? null : current);
        current = '';
        dynamic = false;
      }
      current += part;
    });
    if (queryAt !== -1) break;
  }
  segments.push(dynamic ? null : current);
  const trimmed = segments.slice(1);
  while (trimmed.length > 1 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  // A bare `/api` or `/api/` is a prefix check (`startsWith('/api/')`), not a call.
  return trimmed.length > 1 ? trimmed : null;
}

type RouteMatcher = { route: string; segments: string[] };

export function routeMatchers(routes: readonly string[]): RouteMatcher[] {
  return routes.map(route => ({ route, segments: route.split('/').slice(1) }));
}

const isDynamicSegment = (segment: string) => segment.startsWith('[');
const isCatchAll = (segment: string) => segment.startsWith('[...') || segment.startsWith('[[...');

/**
 * A catch-all directly under `/api` or a version root (`/api/v1/[...x]`): the 404 handler for paths
 * nothing else serves. A deeper catch-all (`/api/app-files/serve/[...key]`) is a real route.
 */
export function isFallbackRoute(route: string): boolean {
  const segments = route.split('/').slice(1);
  if (!isCatchAll(segments[segments.length - 1] ?? '')) return false;
  return segments.length === 2 || (segments.length === 3 && /^v\d+$/.test(segments[1]));
}

/** `['api', 'sessions', null]` -> `/api/sessions/:param`. */
export const formatCallerPath = (caller: CallerPath) =>
  `/${caller.map(segment => (segment === null ? ':param' : segment)).join('/')}`;

/** A client path that only a 404 fallback route (`isFallbackRoute`) answers. */
export type UnresolvedCall = { path: string; caller: string };

const STATIC_RANK = 2;
const DYNAMIC_RANK = 1;
const CATCH_ALL_RANK = 0;

/**
 * Per-segment specificity of the route for this caller path (static > dynamic > catch-all, which is
 * how Next picks between overlapping routes), or null when the route cannot serve the path.
 */
function matchRanks(caller: CallerPath, segments: readonly string[]): number[] | null {
  const ranks: number[] = [];
  for (let position = 0; position < segments.length; position++) {
    const segment = segments[position];
    if (isCatchAll(segment)) {
      const optional = segment.startsWith('[[');
      return caller.length > position || optional ? [...ranks, CATCH_ALL_RANK] : null;
    }
    if (position >= caller.length) return null;
    if (isDynamicSegment(segment)) {
      ranks.push(DYNAMIC_RANK);
      continue;
    }
    if (caller[position] !== segment) return null;
    ranks.push(STATIC_RANK);
  }
  return caller.length === segments.length ? ranks : null;
}

function compareRanks(a: readonly number[], b: readonly number[]): number {
  for (let position = 0; position < Math.min(a.length, b.length); position++) {
    if (a[position] !== b[position]) return a[position] - b[position];
  }
  return a.length - b.length;
}

/** The most specific route(s) a caller path reaches, ranked the way Next resolves overlapping routes. */
export function matchCallerPath(caller: CallerPath, matchers: readonly RouteMatcher[]): string[] {
  let best: number[] | null = null;
  let winners: string[] = [];
  for (const matcher of matchers) {
    const ranks = matchRanks(caller, matcher.segments);
    if (!ranks) continue;
    const comparison = best ? compareRanks(ranks, best) : 1;
    if (comparison > 0) {
      best = ranks;
      winners = [matcher.route];
    } else if (comparison === 0) {
      winners.push(matcher.route);
    }
  }
  return winners;
}

const MAX_LISTED_CALLERS = 3;

export const INVENTORY_REGENERATE_COMMAND = 'pnpm --filter @bike4mind/scripts api-routes:inventory';

/** First segment under /api, so `/api/admin/users` groups under `admin` and `/api/chat` under `chat`. */
export function routeArea(route: string): string {
  return route.split('/')[2] || '(root)';
}

const escapeCell = (value: string) => value.replace(/\|/g, '\\|');

function callersCell(callers: readonly string[]): string {
  if (callers.length === 0) return '0';
  const listed = callers.slice(0, MAX_LISTED_CALLERS).map(caller => `\`${caller}\``);
  const more = callers.length > MAX_LISTED_CALLERS ? ` +${callers.length - MAX_LISTED_CALLERS} more` : '';
  return `${callers.length}: ${listed.join(', ')}${more}`;
}

function methodsCell(record: RouteRecord): string {
  if (record.methods.length > 0) return record.methods.join(', ');
  return record.acceptsAnyMethod ? 'any' : '?';
}

const codeList = (values: readonly string[]) => values.map(value => `\`${value}\``).join(', ');

function scopesCell(record: RouteRecord): string {
  if (record.methodScopes) {
    return record.methodScopes
      .map(group => `${group.methods.join(', ')}: ${group.scopes.length ? codeList(group.scopes) : '-'}`)
      .join('; ');
  }
  return record.scopes.length ? codeList(record.scopes) : '-';
}

function routeRow(record: RouteRecord): string {
  const cells = [
    `\`${record.route}\``,
    methodsCell(record),
    record.auth.join(', '),
    scopesCell(record),
    record.contracted ? 'yes' : 'no',
    record.aliasOf ? `\`${record.aliasOf}\`` : '-',
    callersCell(record.callers),
  ];
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

const countWhere = (records: readonly RouteRecord[], predicate: (record: RouteRecord) => boolean) =>
  records.filter(predicate).length;

/** Deterministic output (sorted, no timestamps) so a regenerated file diffs only on real change. */
export function renderInventoryMarkdown(
  records: readonly RouteRecord[],
  unresolved: readonly UnresolvedCall[] = []
): string {
  const sorted = [...records].sort((a, b) => a.route.localeCompare(b.route));
  const areas = countBy(sorted, record => routeArea(record.route));
  const lines = [
    '# API route inventory',
    '',
    `<!-- Generated by \`${INVENTORY_REGENERATE_COMMAND}\`. Do not edit by hand. -->`,
    '',
    'Every route under `apps/client/pages/api`, read statically from source. Use it to find overlapping routes',
    'and deprecation candidates; the runtime code stays the source of truth. Endpoints served outside',
    '`pages/api` (Lambda routes such as `/api/ai/v1/completions`) and overlay routes are not listed.',
    '',
    `Regenerate with \`${INVENTORY_REGENERATE_COMMAND}\`.`,
    '',
    '## Columns',
    '',
    '- **Methods**: verbs registered on the `baseApi` / `nextRouteForContract` router, `dispatchByMethod` keys,',
    '  or the verbs a raw handler compares `req.method` against. `any` means no verb filter was found (a',
    '  `.use()`-only router, or a raw handler that never checks the method); `?` means the check lives in',
    '  imported code the generator does not follow.',
    '- **Auth**: `jwt+key` session JWT or API key (the `baseApi` default); `jwt` session JWT only',
    "  (`auth: 'jwtOnly'`); `optional` no gate, but a session is read when present; `handler` no session or",
    '  API-key gate (`auth: false`, a public contract, or no `baseApi`), so any check is in the handler (shared',
    '  secret, webhook signature) or there is none: read the handler before calling it public;',
    '  `unknown` options the generator cannot read statically.',
    '- **Scopes**: API-key scopes the route gate accepts (any one of them), listed per verb (`GET: ...; DELETE: ...`)',
    '  when a contract gives verbs different scopes. Empty on a `jwt+key` route means any unconfined API key',
    '  passes the gate. Per-method `assertApiKeyScope` checks inside non-contract handlers are not listed.',
    '- **Contract**: served by `nextRouteForContract`, so the operation is in the public OpenAPI spec. On an alias',
    "  the contract is documented under the alias target's path, not this one.",
    "- **Alias of**: the file only re-exports another route's handler (`export { default } from ...`), so both",
    '  paths serve the same code. Methods, auth, scopes and contract describe that handler.',
    '- **Callers**: files under `apps/client/app` that name the route path. Paths built from runtime values that',
    '  the generator cannot resolve are missed, so `0` means "no static caller found", not "unused".',
    '  Other packages, the CLI and external API clients are not counted. A path that only the `/api` or',
    '  `/api/v1` 404 catch-all would answer is listed under "Client paths with no route" instead.',
    '',
    '## Summary',
    '',
    `${sorted.length} routes: ${countWhere(sorted, record => record.contracted && !record.aliasOf)} contracted, ` +
      `${countWhere(sorted, record => Boolean(record.aliasOf))} aliases of another route, ` +
      `${countWhere(sorted, record => record.callers.length === 0)} with no static caller in \`apps/client/app\`.`,
    '',
    '| Area | Routes | Contracted | jwt+key | jwt | optional | handler | No static caller |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[...areas].map(([area, group]) => {
      const has = (mode: AuthMode) => countWhere(group, record => record.auth.includes(mode));
      return `| ${[
        area,
        group.length,
        countWhere(group, record => record.contracted && !record.aliasOf),
        has('jwt+key'),
        has('jwt'),
        has('optional'),
        has('handler'),
        countWhere(group, record => record.callers.length === 0),
      ].join(' | ')} |`;
    }),
    '',
    '## Routes',
  ];
  for (const [area, group] of areas) {
    lines.push(
      '',
      `### ${area}`,
      '',
      '| Route | Methods | Auth | Scopes | Contract | Alias of | Callers |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...group.map(routeRow)
    );
  }
  lines.push(...unresolvedSection(unresolved));
  return `${lines.join('\n')}\n`;
}

function unresolvedSection(unresolved: readonly UnresolvedCall[]): string[] {
  const unique = [...new Map(unresolved.map(call => [`${call.path} ${call.caller}`, call])).values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.caller.localeCompare(b.caller)
  );
  return [
    '',
    '## Client paths with no route',
    '',
    'Paths under `/api` that `apps/client/app` names but that only a 404 catch-all route answers. Each is a dead call,',
    'a path built in a way the generator misreads, or a string that is not an API call at all; check before acting.',
    '',
    '| Path | Caller |',
    '| --- | --- |',
    ...unique.map(call => `| ${escapeCell(`\`${call.path}\``)} | \`${escapeCell(call.caller)}\` |`),
  ];
}

/**
 * True when `output` lies inside `repoRoot`. Compared case-insensitively because the default macOS
 * filesystem is, so `Docs/x.md` must not slip past a check on `docs/x.md`. Pass realpaths.
 */
export function isInsideRepo(output: string, repoRoot: string): boolean {
  const relative = path.relative(repoRoot.toLowerCase(), output.toLowerCase());
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
