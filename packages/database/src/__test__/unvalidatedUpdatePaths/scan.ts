import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import mongoose from 'mongoose';
import ts from 'typescript';

/**
 * Mechanical half of the unvalidated-update inventory (see ./inventory.ts and the test beside it).
 *
 * Mongoose runs schema validators on create/save only. An update reaches them only when the call
 * passes `runValidators` (or the model gates the path in a pre-update hook), so a constrained path
 * written by any other update call is protected by whatever sits in front of the writer, if anything.
 */

export type Constraint = 'enum' | 'maxlength' | 'minlength' | 'min' | 'max' | 'match';

export interface ConstrainedPath {
  model: string;
  path: string;
  constraints: Constraint[];
}

export interface ScannedWrite {
  model: string;
  /** Schema path with positional segments (`$`, `$[x]`, `N`) removed. */
  path: string;
  constraints: Constraint[];
  /** `relative/file.ts#Class.method` (or `#function`). */
  writer: string;
  /** The call carries `runValidators` (directly or through the McpConnection `withValidators` helper). */
  runValidators: boolean;
  /**
   * Every value this writer stores at the path, when all of them are literals in the source (a fixed
   * `'complete'`, a `0`). `undefined` when any write passes a runtime value.
   */
  literalValues?: (string | number | boolean | null)[];
}

type Literal = string | number | boolean | null;
const NON_LITERAL = Symbol('non-literal');

function literalOf(expr: ts.Expression | undefined): Literal | typeof NON_LITERAL {
  if (!expr) return NON_LITERAL;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return literalOf(expr.expression);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text);
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  return NON_LITERAL;
}

const CONSTRAINT_OPTIONS: Constraint[] = ['enum', 'maxlength', 'minlength', 'min', 'max', 'match'];

function constraintsOf(schemaType: mongoose.SchemaType): Constraint[] {
  const options = schemaType.options as Record<string, unknown>;
  const found = CONSTRAINT_OPTIONS.filter(name => {
    const value = options[name];
    if (value == null) return false;
    if (name === 'enum') {
      const values = Array.isArray(value) ? value : ((value as { values?: unknown[] }).values ?? Object.values(value));
      return Array.isArray(values) && values.length > 0;
    }
    return true;
  });
  // An array of primitives keeps its element constraints on the caster (`tags: [{ type: String, enum }]`).
  const caster = (schemaType as unknown as { caster?: mongoose.SchemaType }).caster;
  if (caster?.options) {
    for (const name of constraintsOf(caster)) if (!found.includes(name)) found.push(name);
  }
  return found;
}

function walkSchema(schema: mongoose.Schema, prefix: string, model: string, out: ConstrainedPath[]): void {
  schema.eachPath((path, schemaType) => {
    const full = prefix ? `${prefix}.${path}` : path;
    const constraints = constraintsOf(schemaType);
    if (constraints.length > 0) out.push({ model, path: full, constraints });
    const nested = (schemaType as unknown as { schema?: mongoose.Schema }).schema;
    if (nested) walkSchema(nested, full, model, out);
  });
}

/** Every enum/maxlength/minlength/min/max/match path of every model registered on the default connection. */
export function collectConstrainedPaths(): ConstrainedPath[] {
  const out: ConstrainedPath[] = [];
  for (const name of mongoose.modelNames().sort()) walkSchema(mongoose.model(name).schema, '', name, out);
  return out;
}

const REMOVAL_OPERATORS = new Set(['$unset', '$rename', '$currentDate', '$pull', '$pullAll', '$pop']);
const UPDATE_METHODS = new Set(['updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate']);
const VALIDATED_OPTIONS = /\brunValidators\s*:\s*true\b|\bwithValidators\(/;

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === '__test__') continue;
      files.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry) && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

function propertyKey(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    // `[`quests.${i}.status`]`: a placeholder that fills a whole positional segment collapses below. One
    // that leads the key or shares a segment with text names an unknown path, so the key is unreadable.
    if (ts.isTemplateExpression(expr)) {
      if (!expr.head.text.endsWith('.')) return undefined;
      const spans = expr.templateSpans.map(span => span.literal.text);
      if (!spans.every(text => text === '' || text.startsWith('.'))) return undefined;
      return expr.head.text + spans.map(text => `0${text}`).join('');
    }
  }
  return undefined;
}

function normalizePath(path: string): string {
  return path
    .split('.')
    .filter(segment => segment !== '$' && !/^\$\[.*\]$/.test(segment) && !/^\d+$/.test(segment))
    .join('.');
}

interface WrittenKey {
  path: string;
  /** Literal stored at `path`; NON_LITERAL for a runtime value or a whole-subdocument write. */
  value: Literal | typeof NON_LITERAL;
}

/** Literal keys the update document writes, as normalized dotted paths. */
function writtenKeys(update: ts.Expression): WrittenKey[] {
  const keys: WrittenKey[] = [];
  const isPipeline = ts.isArrayLiteralExpression(update);
  const fromObject = (obj: ts.ObjectLiteralExpression, operator?: string) => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      const key = propertyKey(prop.name);
      if (!key) continue;
      if (key.startsWith('$')) {
        // These remove or move values, or store a server date: no caller-chosen value lands at the path.
        if (REMOVAL_OPERATORS.has(key)) continue;
        if (ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
          fromObject(prop.initializer, key);
        }
        continue;
      }
      let value = ts.isPropertyAssignment(prop) ? literalOf(prop.initializer) : NON_LITERAL;
      // `$inc: { n: 1 }` stores a computed total, and a pipeline `'$field'` is a field reference.
      if (operator === '$inc' || operator === '$mul') value = NON_LITERAL;
      if (isPipeline && typeof value === 'string' && value.startsWith('$')) value = NON_LITERAL;
      keys.push({ path: normalizePath(key), value });
    }
  };
  if (ts.isObjectLiteralExpression(update)) fromObject(update);
  if (isPipeline) {
    for (const stage of update.elements) if (ts.isObjectLiteralExpression(stage)) fromObject(stage);
  }
  return keys;
}

function isFunctionLike(node: ts.Node | undefined): boolean {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function enclosingWriter(node: ts.Node): { className?: string; member?: string } {
  let member: string | undefined;
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (!member) {
      if ((ts.isMethodDeclaration(cur) || ts.isFunctionDeclaration(cur)) && cur.name && ts.isIdentifier(cur.name)) {
        member = cur.name.text;
      } else if (
        (ts.isVariableDeclaration(cur) || ts.isPropertyDeclaration(cur) || ts.isPropertyAssignment(cur)) &&
        ts.isIdentifier(cur.name) &&
        isFunctionLike(cur.initializer)
      ) {
        member = cur.name.text;
      }
    }
    if (ts.isClassDeclaration(cur)) return { className: cur.name?.text, member };
  }
  return { member };
}

export interface ModelResolution {
  /** Repository class name -> (instance property -> model name), from each exported repository instance. */
  classToModel: Map<string, Map<string, string>>;
  /** Exported model identifier -> model name. */
  identifierToModel: Map<string, string>;
}

/** Builds the identifier maps from the package barrel's runtime exports. */
export function resolveModels(barrel: Record<string, unknown>): ModelResolution {
  const classToModel = new Map<string, Map<string, string>>();
  const identifierToModel = new Map<string, string>();
  for (const [name, value] of Object.entries(barrel)) {
    if (typeof value === 'function' && (value as { prototype?: unknown }).prototype instanceof mongoose.Model) {
      identifierToModel.set(name, (value as mongoose.Model<unknown>).modelName);
    } else if (value && typeof value === 'object') {
      const className = (value as object).constructor?.name;
      if (!className || className === 'Object') continue;
      const properties = new Map<string, string>();
      for (const [property, held] of Object.entries(value)) {
        if (typeof held === 'function' && typeof (held as { modelName?: unknown }).modelName === 'string') {
          properties.set(property, (held as mongoose.Model<unknown>).modelName);
        }
      }
      if (properties.size > 0) classToModel.set(className, properties);
    }
  }
  return { classToModel, identifierToModel };
}

const MODEL_REGISTRATION = /\bmodel(?:<[^>]*>)?\(\s*['"]([A-Za-z0-9_]+)['"]/g;

/**
 * Every literal update call under `modelsRoot` that writes a constrained path, with whether the
 * call itself runs validators. Calls whose receiver or update document cannot be read statically
 * (a spread, a variable update document) are not reported: the inventory covers literal writes.
 */
export function scanUpdateWrites(
  modelsRoot: string,
  constrained: ConstrainedPath[],
  resolution: ModelResolution
): ScannedWrite[] {
  const byModel = new Map<string, ConstrainedPath[]>();
  for (const entry of constrained) {
    const list = byModel.get(entry.model);
    if (list) list.push(entry);
    else byModel.set(entry.model, [entry]);
  }

  const writes = new Map<string, ScannedWrite>();
  for (const file of listSourceFiles(modelsRoot)) {
    const text = readFileSync(file, 'utf8');
    const registered = [...text.matchAll(MODEL_REGISTRATION)].map(m => m[1]!);
    const fileModel = new Set(registered).size === 1 ? registered[0] : undefined;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = relative(modelsRoot, file).split(sep).join('/');

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        UPDATE_METHODS.has(node.expression.name.text) &&
        node.arguments.length >= 2
      ) {
        const receiver = node.expression.expression;
        const { className, member } = enclosingWriter(node);
        let model: string | undefined;
        if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const held = className ? resolution.classToModel.get(className) : undefined;
          model = held?.get(receiver.name.text) ?? held?.get('model') ?? fileModel;
        } else if (ts.isIdentifier(receiver)) {
          model = resolution.identifierToModel.get(receiver.text) ?? fileModel;
        }
        const paths = model ? byModel.get(model) : undefined;
        if (model && paths) {
          const options = node.arguments[2];
          const runValidators = options ? VALIDATED_OPTIONS.test(options.getText(source)) : false;
          const writer = `${rel}#${className ? `${className}.` : ''}${member ?? '<anonymous>'}`;
          for (const { path: key, value } of writtenKeys(node.arguments[1]!)) {
            // A key writes its own path and, when it sets a whole subdocument, every constrained path below it.
            for (const target of paths.filter(p => p.path === key || p.path.startsWith(`${key}.`))) {
              const id = `${model}|${target.path}|${writer}`;
              const prior = writes.get(id);
              const literal = target.path === key ? value : NON_LITERAL;
              const priorLiterals = prior ? prior.literalValues : [];
              // One writer may hold several calls; it is only gated if every call is.
              writes.set(id, {
                model,
                path: target.path,
                constraints: target.constraints,
                writer,
                runValidators: (prior?.runValidators ?? true) && runValidators,
                literalValues:
                  priorLiterals && literal !== NON_LITERAL ? [...new Set([...priorLiterals, literal])] : undefined,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...writes.values()].sort((a, b) =>
    `${a.model}|${a.path}|${a.writer}`.localeCompare(`${b.model}|${b.path}|${b.writer}`)
  );
}
