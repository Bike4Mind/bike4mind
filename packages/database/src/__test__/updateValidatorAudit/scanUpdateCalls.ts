import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const UPDATE_METHODS = new Set([
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'bulkWrite',
]);

// Operators whose written paths Mongoose runs update validators against.
const VALIDATED_OPERATORS = new Set(['$set', '$setOnInsert', '$push', '$addToSet']);

// Operators Mongoose never validates: a `min`/`max` path written through one is unguarded even when
// the call passes `runValidators: true`.
const UNVALIDATABLE_OPERATORS = new Set(['$inc', '$min', '$max', '$mul']);

export type UpdateCallSite = {
  file: string;
  line: number;
  writer: string;
  method: string;
  /** Source text of the call receiver, kept so an unresolved site can be traced by hand. */
  receiver: string;
  /** Model name resolved from the receiver, or null when the receiver could not be tied to one. */
  model: string | null;
  /** `call-site` = runValidators: true is passed; `raw-driver` = bypasses Mongoose entirely; `none` otherwise. */
  gate: 'call-site' | 'raw-driver' | 'none';
  /** Literal paths written under a validated operator, with positional segments stripped. */
  paths: string[];
  /** Literal paths written under `$inc`/`$min`/`$max`/`$mul`, which no `runValidators` setting reaches. */
  unvalidatablePaths: string[];
  /** The payload is a spread, variable, pipeline or computed key, so its paths are not statically known. */
  dynamic: boolean;
};

export type RepositorySite = {
  file: string;
  className: string;
  model: string | null;
};

export type ScanResult = { sites: UpdateCallSite[]; repositories: RepositorySite[] };

/** Cross-file lookup tables so an imported model variable or an injected `Model<T>` still resolves. */
export type ModelIndex = {
  varToModel: Map<string, string>;
  typeToModel: Map<string, string>;
};

/**
 * Receivers the scanner cannot tie to a model by itself, keyed `file|writer|method`. Each one is a
 * repository whose model is typed through an alias or a discriminator, or a schema method acting on
 * `this`. `scanModelsDir` leaves any site absent from here and unresolved as `model: null`.
 */
export const MODEL_OVERRIDES: Record<string, string> = {
  'ai/McpConnectionModel.ts|McpConnectionRepository|repository': 'McpConnection',
  'ai/McpConnectionModel.ts|McpConnectionRepository.updateMany|updateMany': 'McpConnection',
  'content/TagModel.ts|FileTagRepository|repository': 'Tag',
  'content/TagModel.ts|FileTagRepository.updateMany|updateMany': 'Tag',
  'content/TagModel.ts|FileTagRepository.touchLastActivityBy|updateOne': 'Tag',
  'content/TagModel.ts|FileTagRepository.findOrCreateByNameAndUserId|findOneAndUpdate': 'Tag',
  'infra/admin/OrganizationModel.ts|OrganizationSchema|updateOne': 'Organization',
};

export const normalizeWrittenPath = (raw: string): string =>
  raw
    .split('.')
    .filter(segment => segment !== '$' && !/^\$\[.*\]$/.test(segment) && !/^\d+$/.test(segment))
    .join('.');

const propertyName = (node: ts.PropertyName): string | null => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
};

const isThis = (node: ts.Node): boolean => node.kind === ts.SyntaxKind.ThisKeyword;

const castType = (node: ts.Expression): ts.TypeNode | undefined => {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return ts.isAsExpression(current) ? current.type : undefined;
};

const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
};

type WrittenPaths = { paths: string[]; unvalidatablePaths: string[]; dynamic: boolean };

const collectPaths = (updateArg: ts.Expression | undefined): WrittenPaths => {
  if (!updateArg) return { paths: [], unvalidatablePaths: [], dynamic: true };
  const root = unwrap(updateArg);
  if (!ts.isObjectLiteralExpression(root)) return { paths: [], unvalidatablePaths: [], dynamic: true };

  const paths: string[] = [];
  const unvalidatablePaths: string[] = [];
  let dynamic = false;
  const addKeys = (obj: ts.ObjectLiteralExpression, into: string[]) => {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        dynamic = true;
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        into.push(prop.name.text);
      } else if (prop.name) {
        const key = propertyName(prop.name);
        if (key === null) dynamic = true;
        else into.push(key);
      }
    }
  };

  for (const prop of root.properties) {
    if (ts.isSpreadAssignment(prop)) {
      dynamic = true;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      paths.push(prop.name.text);
      continue;
    }
    if (!prop.name) continue;
    const key = propertyName(prop.name);
    if (key === null) {
      dynamic = true;
    } else if (key.startsWith('$')) {
      const target = VALIDATED_OPERATORS.has(key)
        ? paths
        : UNVALIDATABLE_OPERATORS.has(key)
          ? unvalidatablePaths
          : null;
      if (!target) continue;
      const value = ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : null;
      if (value && ts.isObjectLiteralExpression(value)) addKeys(value, target);
      else dynamic = true;
    } else {
      paths.push(key);
    }
  }
  const normalize = (list: string[]) => [...new Set(list.map(normalizeWrittenPath))];
  return { paths: normalize(paths), unvalidatablePaths: normalize(unvalidatablePaths), dynamic };
};

const isTrueRunValidators = (obj: ts.ObjectLiteralExpression): boolean =>
  obj.properties.some(
    prop =>
      ts.isPropertyAssignment(prop) &&
      propertyName(prop.name) === 'runValidators' &&
      prop.initializer.kind === ts.SyntaxKind.TrueKeyword
  );

// `Model.updateOne(f, u).setOptions({ runValidators: true })` validates just like the inline option.
const chainSetsRunValidators = (call: ts.CallExpression): boolean => {
  let current: ts.Node = call;
  while (
    ts.isPropertyAccessExpression(current.parent) &&
    current.parent.expression === current &&
    ts.isCallExpression(current.parent.parent)
  ) {
    const outer: ts.CallExpression = current.parent.parent;
    if (current.parent.name.text === 'setOptions') {
      const arg = outer.arguments[0] && unwrap(outer.arguments[0]);
      if (arg && ts.isObjectLiteralExpression(arg) && isTrueRunValidators(arg)) return true;
    }
    current = outer;
  }
  return false;
};

const typeIdentifiers = (node: ts.Node): string[] => {
  const out: string[] = [];
  const visit = (inner: ts.Node) => {
    if (ts.isTypeReferenceNode(inner)) out.push(inner.typeName.getText());
    ts.forEachChild(inner, visit);
  };
  visit(node);
  return out;
};

const collectStringConsts = (sf: ts.SourceFile): Map<string, string> => {
  const consts = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(unwrap(node.initializer))
    ) {
      consts.set(node.name.text, (unwrap(node.initializer) as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return consts;
};

// `model<IFoo, Model<IFooDocument>>('Foo', schema)` or `mongoose.model('Foo', schema)`; the name may
// be a same-file string const.
const modelFactoryCall = (node: ts.Node, consts: Map<string, string>): { name: string; types: string[] } | null => {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  const isFactory =
    (ts.isIdentifier(callee) && callee.text === 'model') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'model' && !isThis(callee.expression));
  const [first, second] = node.arguments;
  if (!isFactory || !first || !second) return null;
  const name = ts.isStringLiteralLike(first) ? first.text : ts.isIdentifier(first) ? consts.get(first.text) : undefined;
  if (!name) return null;
  return { name, types: (node.typeArguments ?? []).flatMap(typeIdentifiers) };
};

const declarationName = (node: ts.Node): string | null => {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
    if (ts.isStatement(current)) return null;
  }
  return null;
};

export function indexModels(sources: Array<{ text: string; fileName: string }>): ModelIndex {
  const varToModel = new Map<string, string>();
  const typeToModel = new Map<string, string>();
  const ambiguous = new Set<string>();
  const claim = (map: Map<string, string>, key: string, model: string) => {
    if (map.has(key) && map.get(key) !== model) ambiguous.add(`${map === varToModel ? 'v' : 't'}:${key}`);
    map.set(key, model);
  };
  for (const { text, fileName } of sources) {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const consts = collectStringConsts(sf);
    const visit = (node: ts.Node) => {
      const factory = modelFactoryCall(node, consts);
      if (factory) {
        const variable = declarationName(node);
        if (variable) claim(varToModel, variable, factory.name);
        for (const type of factory.types) claim(typeToModel, type, factory.name);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const key of ambiguous) (key.startsWith('v:') ? varToModel : typeToModel).delete(key.slice(2));
  return { varToModel, typeToModel };
}

// `Model<IFooDocument>` / `mongoose.Model<IFooDocument>` / `BaseRepository<IFooDocument>`.
const modelFromType = (type: ts.TypeNode | undefined, index: ModelIndex): string | null => {
  if (!type) return null;
  for (const name of typeIdentifiers(type)) {
    const model = index.typeToModel.get(name);
    if (model) return model;
  }
  return null;
};

const enclosingWriter = (node: ts.Node): string => {
  const names: string[] = [];
  let variable: string | null = null;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name) {
      names.unshift(current.name.getText());
    } else if (ts.isClassDeclaration(current) && current.name) {
      names.unshift(current.name.text);
    } else if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      variable = current.name.text;
    }
  }
  // An arrow function bound to a const has no name of its own, so the binding stands in.
  return names.join('.') || variable || '<module>';
};

export function scanSource(fileName: string, text: string, index: ModelIndex): ScanResult {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const consts = collectStringConsts(sf);
  const local = indexModels([{ text, fileName }]);
  const resolveVar = (name: string) => local.varToModel.get(name) ?? index.varToModel.get(name) ?? null;
  const fileModels = new Set(local.varToModel.values());
  const onlyFileModel = fileModels.size === 1 ? [...fileModels][0] : null;

  // Per class: property name -> model name, from the heritage generic, `super(Model)`, typed
  // constructor parameters, `this.x = <model>` and typed property declarations.
  const classProps = new Map<ts.ClassDeclaration, Map<string, string>>();
  const visitClasses = (node: ts.Node) => {
    if (ts.isClassDeclaration(node)) {
      const props = new Map<string, string>();
      const params = new Map<string, string>();
      for (const clause of node.heritageClauses ?? []) {
        for (const heritage of clause.types) {
          const model = (heritage.typeArguments ?? [])
            .map(arg => modelFromType(arg, index))
            .find((m): m is string => m !== null);
          if (model && /Repository$/.test(heritage.expression.getText())) props.set('model', model);
        }
      }
      const resolveExpr = (expr: ts.Expression | undefined): string | null => {
        const target = expr ? unwrap(expr) : undefined;
        if (!target) return null;
        if (ts.isIdentifier(target)) return params.get(target.text) ?? resolveVar(target.text);
        return modelFactoryCall(target, consts)?.name ?? null;
      };
      const visitMembers = (inner: ts.Node) => {
        if (ts.isParameter(inner) && ts.isIdentifier(inner.name)) {
          const model = modelFromType(inner.type, index);
          if (model) {
            params.set(inner.name.text, model);
            if (inner.modifiers?.some(m => m.kind !== ts.SyntaxKind.Decorator)) props.set(inner.name.text, model);
          }
        } else if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.SuperKeyword) {
          const model = resolveExpr(inner.arguments[0]);
          if (model) props.set('model', model);
        } else if (
          ts.isBinaryExpression(inner) &&
          inner.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(inner.left) &&
          isThis(inner.left.expression)
        ) {
          const model = resolveExpr(inner.right);
          if (model) props.set(inner.left.name.text, model);
        } else if (ts.isPropertyDeclaration(inner) && ts.isIdentifier(inner.name)) {
          const model = resolveExpr(inner.initializer) ?? modelFromType(inner.type, index);
          if (model) props.set(inner.name.text, model);
        }
        ts.forEachChild(inner, visitMembers);
      };
      visitMembers(node);
      classProps.set(node, props);
    }
    ts.forEachChild(node, visitClasses);
  };
  visitClasses(sf);

  const sites: UpdateCallSite[] = [];

  const ownerProps = (from: ts.Node) => {
    let owner: ts.Node | undefined = from.parent;
    while (owner && !ts.isClassDeclaration(owner)) owner = owner.parent;
    return owner ? { owner: owner as ts.ClassDeclaration, props: classProps.get(owner as ts.ClassDeclaration) } : null;
  };

  // A repository named `FooRepository` over a model named `Foo`, when nothing typed the model.
  const modelByClassName = (owner: ts.ClassDeclaration): string | null => {
    const base = owner.name?.text.replace(/Repository$/, '');
    return base && fileModels.has(base) ? base : null;
  };

  const resolveReceiver = (receiver: ts.Expression, from: ts.Node): string | null => {
    const cast = modelFromType(castType(receiver), index);
    if (cast) return cast;
    const target = unwrap(receiver);
    if (ts.isIdentifier(target)) {
      for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
        if (!ts.isFunctionLike(scope)) continue;
        const param = scope.parameters.find(p => ts.isIdentifier(p.name) && p.name.text === target.text);
        if (param) return modelFromType(param.type, index);
      }
      return resolveVar(target.text);
    }
    if (target.kind === ts.SyntaxKind.SuperKeyword || target.kind === ts.SyntaxKind.ThisKeyword) {
      return ownerProps(from)?.props?.get('model') ?? null;
    }
    if (ts.isPropertyAccessExpression(target) && isThis(target.expression)) {
      const scope = ownerProps(from);
      return (
        scope?.props?.get(target.name.text) ??
        (scope ? modelByClassName(scope.owner) : null) ??
        (target.name.text === 'model' ? onlyFileModel : null)
      );
    }
    return modelFactoryCall(target, consts)?.name ?? null;
  };

  const visitCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const method = callee.name.text;
      const receiver = callee.expression;
      if (UPDATE_METHODS.has(method)) {
        const rawDriver = ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'collection';
        const model = resolveReceiver(
          rawDriver ? (receiver as ts.PropertyAccessExpression).expression : receiver,
          node
        );
        const [, updateArg, optionsArg] = node.arguments;
        const optionsObject = optionsArg ? unwrap(optionsArg) : null;
        const validated =
          (optionsObject !== null &&
            ts.isObjectLiteralExpression(optionsObject) &&
            isTrueRunValidators(optionsObject)) ||
          chainSetsRunValidators(node);
        const written: WrittenPaths =
          method === 'bulkWrite' ? { paths: [], unvalidatablePaths: [], dynamic: true } : collectPaths(updateArg);
        const writer = enclosingWriter(node);
        sites.push({
          file: fileName,
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          writer,
          method,
          receiver: receiver.getText(sf),
          model: model ?? MODEL_OVERRIDES[`${fileName}|${writer}|${method}`] ?? null,
          gate: rawDriver ? 'raw-driver' : validated ? 'call-site' : 'none',
          paths: written.paths,
          unvalidatablePaths: written.unvalidatablePaths,
          dynamic: written.dynamic || method === 'replaceOne' || method === 'findOneAndReplace',
        });
      }
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(sf);

  const repositories: RepositorySite[] = [];
  for (const [declaration, props] of classProps) {
    const extendsBase = declaration.heritageClauses?.some(clause =>
      clause.types.some(type => type.expression.getText() === 'BaseRepository')
    );
    if (!extendsBase || !declaration.name) continue;
    const className = declaration.name.text;
    repositories.push({
      file: fileName,
      className,
      model:
        props.get('model') ??
        modelByClassName(declaration) ??
        MODEL_OVERRIDES[`${fileName}|${className}|repository`] ??
        null,
    });
  }
  return { sites, repositories };
}

const isSourceFile = (name: string) =>
  name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(name) && !name.endsWith('.d.ts');

export function listModelSourceFiles(modelsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__' && entry.name !== '__test__') walk(full);
      } else if (isSourceFile(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(modelsDir);
  return out.sort();
}

export function scanModelsDir(modelsDir: string): ScanResult {
  const files = listModelSourceFiles(modelsDir).map(file => ({
    fileName: path.relative(modelsDir, file),
    text: fs.readFileSync(file, 'utf8'),
  }));
  const index = indexModels(files);
  const results = files.map(({ fileName, text }) => scanSource(fileName, text, index));
  return {
    sites: results.flatMap(result => result.sites),
    repositories: results.flatMap(result => result.repositories),
  };
}
