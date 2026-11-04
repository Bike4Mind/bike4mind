/**
 * Admin write audit coverage. Every mutating verb (POST, PUT, PATCH, DELETE) a handler under
 * apps/client/pages/api/admin registers must reach an AdminAuditLog writer, or be listed in
 * adminAuditCoverageExemptions.ts with the reason. Enforced by checkAdminAuditCoverage.test.ts.
 *
 * "Reaches" is read from the TypeScript AST, per verb: starting at the function passed to
 * `.post(...)` (etc.), every identifier it references is resolved to its declaration, in the same
 * file or through a relative / `@server` / `@client` / `@bike4mind/server-utils` import, and searched
 * the same way, until a call to one of AUDIT_WRITERS is found. Package barrels (`@bike4mind/services`,
 * `@bike4mind/database`) are not followed; a service that audits internally needs an exemption entry.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { HttpMethod } from './apiRouteInventory';

export const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const satisfies readonly HttpMethod[];
export type MutatingMethod = (typeof MUTATING_METHODS)[number];

/**
 * Callee names that write an AdminAuditLog row, matched as a bare call (`recordAdminAction(...)`) or a
 * method call (`adminAuditService.recordAdminAction(...)`). Helpers that wrap these (usersBulk/*,
 * adminUserNotes, ...) need no entry: the import walk finds the writer inside them.
 * Must stay in sync with the writers in apps/client/server/utils/adminAudit.ts,
 * apps/client/server/utils/adminSettingsAudit.ts, apps/client/server/tools/recordModalChanges.ts and
 * b4m-core/services/src/adminAuditService/recordAdminAction.ts.
 */
export const AUDIT_WRITERS: ReadonlySet<string> = new Set([
  'recordAdminAction',
  'recordAdminActionFromRequest',
  'recordAdminActionForActor',
  'recordAdminSettingChange',
  'recordModalChanges',
]);

/**
 * Helpers that write an audit row for a refused request, not for the write itself. The walk does not
 * enter them, so a handler is not credited with coverage because it audits its denial path.
 */
export const DENIAL_AUDIT_HELPERS: ReadonlySet<string> = new Set(['denySelfAdminAction']);

/** Import specifier prefixes resolved to source directories (apps/client/tsconfig.json paths). */
const ALIASES: ReadonlyArray<[prefix: string, dir: string]> = [
  ['@server/', 'apps/client/server/'],
  ['@client/', 'apps/client/'],
  ['@/', 'apps/client/'],
  ['@bike4mind/server-utils/', 'packages/server-utils/src/'],
];

const ROUTER_METHODS: Readonly<Record<string, MutatingMethod>> = {
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};

/** `witness`: the `file:line` of the audit writer call the verb reaches, or null when it reaches none. */
export type VerbCoverage = { method: MutatingMethod; witness: string | null };
export type HandlerCoverage =
  | { kind: 'analyzed'; verbs: VerbCoverage[] }
  /** The file has a default export but no router chain this reader understands. */
  | { kind: 'unreadable' };

type Declaration = { file: string; node: ts.Node };

/** Reads and resolves source files under `root`; one instance memoizes parses and answers. */
export class AuditReachability {
  private readonly sources = new Map<string, ts.SourceFile | null>();
  private readonly witnesses = new Map<string, string | null>();

  constructor(
    private readonly root: string,
    private readonly readSource: (file: string) => string | null = file => {
      const absolute = path.join(root, file);
      return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
    }
  ) {}

  sourceFile(file: string): ts.SourceFile | null {
    if (!this.sources.has(file)) {
      const text = this.readSource(file);
      this.sources.set(
        file,
        text === null ? null : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
      );
    }
    return this.sources.get(file) ?? null;
  }

  /** Repo-relative module file for an import specifier, or null when it is not followed. */
  resolveModule(fromFile: string, specifier: string): string | null {
    let base: string | null = null;
    if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(fromFile), specifier);
    for (const [prefix, dir] of ALIASES) {
      if (base === null && specifier.startsWith(prefix)) base = dir + specifier.slice(prefix.length);
    }
    if (base === null) return null;
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    return candidates.find(candidate => /\.tsx?$/.test(candidate) && this.sourceFile(candidate) !== null) ?? null;
  }

  /**
   * The audit writer call one router-method handler expression (an argument passed to `.post(...)`)
   * reaches, as `file:line`, or null when it reaches none.
   */
  auditWitness(file: string, node: ts.Node): string | null {
    return this.nodeWitness(file, node, new Set());
  }

  private nodeWitness(file: string, node: ts.Node, visiting: Set<string>): string | null {
    let witness: string | null = null;
    const visit = (child: ts.Node): void => {
      if (witness !== null) return;
      if (ts.isCallExpression(child) && AUDIT_WRITERS.has(calleeName(child.expression) ?? '')) {
        const source = child.getSourceFile();
        witness = `${file}:${source.getLineAndCharacterOfPosition(child.getStart(source)).line + 1}`;
        return;
      }
      if (ts.isIdentifier(child) && DENIAL_AUDIT_HELPERS.has(child.text)) return;
      if (ts.isIdentifier(child) && isReference(child)) {
        witness = this.declarationWitness(this.resolveBinding(file, child.text), visiting);
        if (witness !== null) return;
      }
      if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression)) {
        witness = this.declarationWitness(
          this.resolveNamespaceMember(file, child.expression.text, child.name.text),
          visiting
        );
        if (witness !== null) return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return witness;
  }

  private resolveNamespaceMember(file: string, namespace: string, member: string): Declaration | null {
    const source = this.sourceFile(file);
    const specifier = source && namespaceImportSpecifier(source, namespace);
    const target = specifier ? this.resolveModule(file, specifier) : null;
    return target ? this.resolveExport(target, member, new Set()) : null;
  }

  private declarationWitness(declaration: Declaration | null, visiting: Set<string>): string | null {
    if (declaration === null) return null;
    const key = `${declaration.file}:${declaration.node.pos}`;
    const known = this.witnesses.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return null;
    visiting.add(key);
    const witness = this.nodeWitness(declaration.file, declaration.node, visiting);
    visiting.delete(key);
    // Inside a cycle a miss is only provisional, so only memoize settled answers.
    if (witness !== null || visiting.size === 0) this.witnesses.set(key, witness);
    return witness;
  }

  /** The top-level declaration `name` refers to in `file`: local, or followed through its import. */
  private resolveBinding(file: string, name: string): Declaration | null {
    const source = this.sourceFile(file);
    if (!source) return null;
    for (const statement of source.statements) {
      const local = localDeclaration(statement, name);
      if (local) return { file, node: local };
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const imported = importedName(statement, name);
        if (imported === null) continue;
        const target = this.resolveModule(file, statement.moduleSpecifier.text);
        return target ? this.resolveExport(target, imported, new Set()) : null;
      }
    }
    return null;
  }

  private resolveExport(file: string, name: string, seen: Set<string>): Declaration | null {
    if (seen.has(`${file}:${name}`)) return null;
    seen.add(`${file}:${name}`);
    const source = this.sourceFile(file);
    if (!source) return null;
    for (const statement of source.statements) {
      const local = localDeclaration(statement, name);
      if (local) return { file, node: local };
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      const exportClause = statement.exportClause;
      if (exportClause && ts.isNamedExports(exportClause)) {
        const element = exportClause.elements.find(entry => entry.name.text === name);
        if (!element) continue;
        const original = (element.propertyName ?? element.name).text;
        if (!specifier) return this.resolveBinding(file, original);
        const target = this.resolveModule(file, specifier);
        return target ? this.resolveExport(target, original, seen) : null;
      }
      if (!exportClause && specifier) {
        const target = this.resolveModule(file, specifier);
        const found = target ? this.resolveExport(target, name, seen) : null;
        if (found) return found;
      }
    }
    return null;
  }
}

// A `.ts` file must not parse as TSX: a generic arrow (`<T>(fn) => ...`) would read as JSX.
const scriptKind = (file: string) => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** An identifier read as a value: not a property name, declaration name or object-literal key. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) &&
    parent.name === node
  )
    return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return false;
  return !ts.isTypeReferenceNode(parent) && !ts.isImportSpecifier(parent);
}

/** The node declaring top-level `name` in `statement` (a function, a const's initializer, a class), if any. */
function localDeclaration(statement: ts.Statement, name: string): ts.Node | null {
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
    return statement;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer ?? null;
    }
  }
  return null;
}

/** The exported name `local` imports from `statement` (`default` for a default import), or null. */
function importedName(statement: ts.ImportDeclaration, local: string): string | null {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) return null;
  if (clause.name?.text === local) return 'default';
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return null;
  const element = bindings.elements.find(entry => entry.name.text === local && !entry.isTypeOnly);
  return element ? (element.propertyName ?? element.name).text : null;
}

function namespaceImportSpecifier(source: ts.SourceFile, namespace: string): string | null {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === namespace) {
      return statement.moduleSpecifier.text;
    }
  }
  return null;
}

/** True when the call chain under `expression` starts at a router factory call (`baseApi()`, `adminApi()`, ...). */
function isRouterChain(source: ts.SourceFile, expression: ts.Expression, seen = new Set<string>()): boolean {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression)) return /api$/i.test(current.expression.text);
      current = current.expression;
    } else if (ts.isPropertyAccessExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isIdentifier(current)) {
      const name = current.text;
      if (seen.has(name)) return false;
      seen.add(name);
      const initializer = source.statements.map(statement => localDeclaration(statement, name)).find(Boolean);
      return !!initializer && ts.isExpression(initializer) && isRouterChain(source, initializer, seen);
    } else {
      return false;
    }
  }
}

/** Per-verb audit coverage of the route module `file`. */
export function analyzeHandlerCoverage(reachability: AuditReachability, file: string): HandlerCoverage {
  const source = reachability.sourceFile(file);
  if (!source) return { kind: 'unreadable' };
  const byMethod = new Map<MutatingMethod, string | null>();
  let sawRouter = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const isRouterCall = isRouterChain(source, node.expression.expression);
      sawRouter ||= isRouterCall;
      const method = ROUTER_METHODS[node.expression.name.text];
      if (method && isRouterCall) {
        const witness =
          node.arguments.map(argument => reachability.auditWitness(file, argument)).find(found => found !== null) ??
          null;
        byMethod.set(method, byMethod.get(method) ?? witness);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!sawRouter) return { kind: 'unreadable' };
  return {
    kind: 'analyzed',
    verbs: MUTATING_METHODS.filter(method => byMethod.has(method)).map(method => ({
      method,
      witness: byMethod.get(method) ?? null,
    })),
  };
}

export type CoverageRoute = { route: string; file: string; coverage: HandlerCoverage };

/** `METHOD /api/route`, the key of an exemption entry. */
export const verbKey = (method: MutatingMethod, route: string) => `${method} ${route}`;

const EXEMPTIONS_FILE = 'packages/scripts/src/adminAuditCoverageExemptions.ts';

export const AUDIT_FIX_INSTRUCTIONS =
  'Record the write with recordAdminActionFromRequest (apps/client/server/utils/adminAudit.ts), or ' +
  'recordAdminSettingChange for an AdminSettings write, using an action from ADMIN_AUDIT_CATALOGUE ' +
  '(b4m-core/common/src/types/entities/adminAuditCatalogue.ts; add one there if none fits). If the verb ' +
  `deliberately writes no audit row, add it to ${EXEMPTIONS_FILE} with a one-line reason.`;

/** Human-readable failures; empty when every mutating verb is audited or exempt and no exemption is stale. */
export function auditCoverageFailures(
  routes: readonly CoverageRoute[],
  exemptions: Readonly<Record<string, string>>
): string[] {
  const failures: string[] = [];
  const verbs = new Map<string, boolean>();
  for (const { route, file, coverage } of routes) {
    if (coverage.kind === 'unreadable') {
      failures.push(
        `${route} (${file}) has no router chain this check can read (expected \`const handler = ` +
          'adminApi(...).post(...)` or baseApi). Register its verbs on a baseApi/adminApi router.'
      );
      continue;
    }
    for (const { method, witness } of coverage.verbs) {
      const key = verbKey(method, route);
      verbs.set(key, witness !== null);
      if (witness === null && !(key in exemptions)) {
        failures.push(`${key} (${file}) changes data but writes no admin audit row. ${AUDIT_FIX_INSTRUCTIONS}`);
      }
    }
  }
  for (const [key, reason] of Object.entries(exemptions)) {
    const audited = verbs.get(key);
    if (audited === undefined) {
      failures.push(`${key} is exempt in ${EXEMPTIONS_FILE} but no such handler verb exists. Remove the entry.`);
    } else if (audited) {
      failures.push(`${key} is exempt in ${EXEMPTIONS_FILE} but now reaches an audit writer. Remove the entry.`);
    }
    if (!reason.trim()) failures.push(`${key} in ${EXEMPTIONS_FILE} needs a reason.`);
  }
  return failures;
}
