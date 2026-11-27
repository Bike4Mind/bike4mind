/**
 * The contract a Python artifact declares to be callable: a module-level `FUNCTION` dict beside `run`. A closed
 * subset of JSON Schema plus a required `unit` on every number, read from the sandbox as untrusted JSON.
 */

export const FUNCTION_CONTRACT_GLOBAL = 'FUNCTION';
export const FUNCTION_ENTRY_POINT = 'run';
export const DIMENSIONLESS_UNIT = '1';
export const FUNCTION_UNIT_PATTERN = /^[A-Za-z0-9%][A-Za-z0-9%^*/.() -]{0,31}$/;
export const FUNCTION_NAME_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
// Property names become Python keyword arguments of `run`.
export const FUNCTION_PROPERTY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// `keyword.kwlist` of Python 3.11, the version Pyodide 0.25.1 runs. Soft keywords such as `match` stay allowed.
export const PYTHON_HARD_KEYWORDS: readonly string[] = (
  'False None True and as assert async await break class continue def del elif else except finally for from ' +
  'global if import in is lambda nonlocal not or pass raise return try while with yield'
).split(' ');

const FUNCTION_CONTRACT_LINE = new RegExp(`^${FUNCTION_CONTRACT_GLOBAL}\\s*=`, 'm');
const RUN_DEFINITION_LINE = new RegExp(`^(async\\s+)?def\\s+${FUNCTION_ENTRY_POINT}\\s*\\(`, 'm');

/**
 * Whether Python code looks like a callable function: a column-0 `FUNCTION =` assignment and a
 * column-0 `def run(`. A text check only; the sandbox is the authority.
 */
export function hasFunctionEntryPoint(code: string): boolean {
  return FUNCTION_CONTRACT_LINE.test(code) && RUN_DEFINITION_LINE.test(code);
}

export const FUNCTION_CONTRACT_LIMITS = {
  maxProperties: 40,
  maxDepth: 4,
  maxEnumValues: 50,
  maxDescriptionLength: 500,
  maxStringLength: 2000,
  maxContractBytes: 32 * 1024,
  /** A call's result, as the server runtime's REST and test surfaces allow it; chat and MCP cap lower per surface. */
  maxResultBytes: 5 * 1024 * 1024,
  maxProblems: 50,
  maxTests: 20,
} as const;

interface FunctionFieldBase {
  description?: string;
}
export interface FunctionNumberField extends FunctionFieldBase {
  type: 'number' | 'integer';
  unit: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  enum?: number[];
  default?: number;
}
export interface FunctionStringField extends FunctionFieldBase {
  type: 'string';
  enum?: string[];
  default?: string;
  maxLength?: number;
}
export interface FunctionBooleanField extends FunctionFieldBase {
  type: 'boolean';
  default?: boolean;
}
export interface FunctionArrayField extends FunctionFieldBase {
  type: 'array';
  items: FunctionField;
  minItems?: number;
  maxItems?: number;
}
export interface FunctionObjectField extends FunctionFieldBase {
  type: 'object';
  properties: Record<string, FunctionField>;
  required?: string[];
  additionalProperties: false;
}
export type FunctionField =
  FunctionNumberField | FunctionStringField | FunctionBooleanField | FunctionArrayField | FunctionObjectField;

/** A number in `expected` matches when it is within `abs` or within `rel` times the expected value; exact by default. */
export interface FunctionTestTolerance {
  abs?: number;
  rel?: number;
}

/** A declared case: a full set of inputs and some of the outputs `run` should return for them. */
export interface FunctionTestCase {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  tolerance?: FunctionTestTolerance;
}

export interface FunctionContract {
  name: string;
  description: string;
  inputs: FunctionObjectField;
  outputs: FunctionObjectField;
  /** Present only when FUNCTION declares it. Outside the projections and the review hash. */
  tests?: FunctionTestCase[];
}

export interface FunctionContractProblem {
  /** Dotted path from the root, such as `inputs.properties.span.unit`; empty for the root itself. */
  path: string;
  message: string;
}

export type FunctionContractParse =
  { ok: true; contract: FunctionContract } | { ok: false; problems: FunctionContractProblem[] };

const FIELD_TYPES = ['number', 'integer', 'string', 'boolean', 'array', 'object'] as const;

const ALLOWED_KEYS: Record<(typeof FIELD_TYPES)[number], readonly string[]> = {
  number: ['unit', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'enum', 'default'],
  integer: ['unit', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'enum', 'default'],
  string: ['enum', 'default', 'maxLength'],
  boolean: ['default'],
  array: ['items', 'minItems', 'maxItems'],
  object: ['properties', 'required', 'additionalProperties'],
};
const COMMON_KEYS = ['type', 'description'];
const CONTRACT_KEYS = ['name', 'description', 'inputs', 'outputs', 'tests'];
const TEST_CASE_KEYS = ['name', 'input', 'expected', 'tolerance'];
const TOLERANCE_KEYS = ['abs', 'rel'] as const;

/** Every keyword a contract field may use, across all field types. */
export const FUNCTION_FIELD_KEYWORDS: readonly string[] = [
  ...new Set([...COMMON_KEYS, ...Object.values(ALLOWED_KEYS).flat()]),
];

/** UTF-8 size of a JSON text, the unit every size limit in this file is stated in. */
export function functionJsonBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function join(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Problems are collected up to `maxProblems` plus one; the extra entry only marks that more were found, and
 * `capFunctionProblems` replaces it with a closing note. Checks stop looping once the list is full.
 */
function report(problems: FunctionContractProblem[], path: string, message: string): void {
  if (problems.length <= FUNCTION_CONTRACT_LIMITS.maxProblems) problems.push({ path, message });
}

function isFull(problems: FunctionContractProblem[]): boolean {
  return problems.length > FUNCTION_CONTRACT_LIMITS.maxProblems;
}

/** At most `maxProblems` problems, followed by one closing entry when more were found. */
export function capFunctionProblems(problems: FunctionContractProblem[]): FunctionContractProblem[] {
  const max = FUNCTION_CONTRACT_LIMITS.maxProblems;
  if (problems.length <= max) return problems;
  return [...problems.slice(0, max), { path: '', message: `more problems were found; the first ${max} are listed` }];
}

// A long enum is summarized so that one failed check per item cannot echo the whole list each time.
function enumMessage(values: readonly (string | number)[]): string {
  const listed = values.join(', ');
  return listed.length > 200 ? `must be one of the ${values.length} allowed values` : `must be one of: ${listed}`;
}

function refuseUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: FunctionContractProblem[]
): void {
  for (const key of Object.keys(record)) {
    if (isFull(problems)) return;
    if (!allowed.includes(key)) report(problems, join(path, key), `"${key}" is not supported`);
  }
}

function checkDescription(record: Record<string, unknown>, path: string, problems: FunctionContractProblem[]): void {
  const description = own(record, 'description');
  if (description === undefined) return;
  if (typeof description !== 'string' || description.length > FUNCTION_CONTRACT_LIMITS.maxDescriptionLength) {
    report(
      problems,
      join(path, 'description'),
      `must be text of at most ${FUNCTION_CONTRACT_LIMITS.maxDescriptionLength} characters`
    );
  }
}

export interface FunctionBound {
  value: number;
  exclusive: boolean;
}

/** An integer field's bounds are rounded inward to the whole numbers they allow. */
export const lowestWhole = ({ value, exclusive }: FunctionBound) =>
  exclusive ? Math.floor(value) + 1 : Math.ceil(value);
export const highestWhole = ({ value, exclusive }: FunctionBound) =>
  exclusive ? Math.ceil(value) - 1 : Math.floor(value);

function checkNumberField(record: Record<string, unknown>, path: string, problems: FunctionContractProblem[]): void {
  const unit = own(record, 'unit');
  if (unit === undefined) {
    report(
      problems,
      join(path, 'unit'),
      `a number field needs a unit (use "${DIMENSIONLESS_UNIT}" for a value without one)`
    );
  } else if (typeof unit !== 'string' || !FUNCTION_UNIT_PATTERN.test(unit)) {
    report(
      problems,
      join(path, 'unit'),
      'may use only letters, digits, spaces, and % ^ * / . ( ) -, up to 32 characters'
    );
  }

  const bounds = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const;
  for (const key of bounds) {
    const bound = own(record, key);
    if (bound !== undefined && !isFiniteNumber(bound)) report(problems, join(path, key), 'must be a finite number');
  }
  const whole = record.type === 'integer';
  const finite = (value: unknown, exclusive: boolean) => (isFiniteNumber(value) ? [{ value, exclusive }] : []);
  const lowers = [...finite(own(record, 'minimum'), false), ...finite(own(record, 'exclusiveMinimum'), true)];
  const uppers = [...finite(own(record, 'maximum'), false), ...finite(own(record, 'exclusiveMaximum'), true)];
  const empty = lowers.some(lower =>
    uppers.some(upper => {
      if (whole) return lowestWhole(lower) > highestWhole(upper);
      return lower.exclusive || upper.exclusive ? lower.value >= upper.value : lower.value > upper.value;
    })
  );
  if (empty) report(problems, join(path, 'minimum'), 'the bounds leave no allowed value');

  const values = own(record, 'enum');
  if (values !== undefined) {
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > FUNCTION_CONTRACT_LIMITS.maxEnumValues ||
      !values.every(v => isFiniteNumber(v) && (!whole || Number.isInteger(v)))
    ) {
      report(
        problems,
        join(path, 'enum'),
        `must list 1 to ${FUNCTION_CONTRACT_LIMITS.maxEnumValues} ${whole ? 'whole numbers' : 'numbers'}`
      );
    }
  }
}

function checkStringField(record: Record<string, unknown>, path: string, problems: FunctionContractProblem[]): void {
  const values = own(record, 'enum');
  if (
    values !== undefined &&
    (!Array.isArray(values) ||
      values.length === 0 ||
      values.length > FUNCTION_CONTRACT_LIMITS.maxEnumValues ||
      !values.every(v => typeof v === 'string' && v.length <= FUNCTION_CONTRACT_LIMITS.maxStringLength))
  ) {
    report(problems, join(path, 'enum'), `must list 1 to ${FUNCTION_CONTRACT_LIMITS.maxEnumValues} text values`);
  }
  const maxLength = own(record, 'maxLength');
  if (maxLength !== undefined && (!isCount(maxLength) || maxLength > FUNCTION_CONTRACT_LIMITS.maxStringLength)) {
    report(
      problems,
      join(path, 'maxLength'),
      `must be a whole number from 0 to ${FUNCTION_CONTRACT_LIMITS.maxStringLength}`
    );
  }
}

function checkArrayField(
  record: Record<string, unknown>,
  path: string,
  depth: number,
  problems: FunctionContractProblem[]
): void {
  const items = own(record, 'items');
  if (items === undefined) {
    report(problems, join(path, 'items'), 'a list field needs an items schema');
  } else {
    checkField(items, join(path, 'items'), depth + 1, problems);
  }
  for (const key of ['minItems', 'maxItems'] as const) {
    const count = own(record, key);
    if (count !== undefined && !isCount(count)) {
      report(problems, join(path, key), 'must be a whole number of 0 or more');
    }
  }
  const minItems = own(record, 'minItems');
  const maxItems = own(record, 'maxItems');
  if (isCount(minItems) && isCount(maxItems) && minItems > maxItems) {
    report(problems, join(path, 'minItems'), 'is greater than maxItems');
  }
}

function checkObjectField(
  record: Record<string, unknown>,
  path: string,
  depth: number,
  problems: FunctionContractProblem[]
): void {
  if (own(record, 'additionalProperties') !== false) {
    report(problems, join(path, 'additionalProperties'), 'must be false');
  }

  const properties = own(record, 'properties');
  const declared = new Set<string>();
  if (!isPlainObject(properties)) {
    report(problems, join(path, 'properties'), 'must be an object of fields');
  } else {
    const names = Object.keys(properties);
    if (names.length > FUNCTION_CONTRACT_LIMITS.maxProperties) {
      report(
        problems,
        join(path, 'properties'),
        `has ${names.length} fields; at most ${FUNCTION_CONTRACT_LIMITS.maxProperties} are allowed`
      );
    }
    for (const name of names) {
      if (isFull(problems)) return;
      const fieldPath = join(join(path, 'properties'), name);
      if (!FUNCTION_PROPERTY_NAME_PATTERN.test(name)) {
        report(
          problems,
          fieldPath,
          'a field name must start with a letter or underscore and use only letters, digits, and underscores'
        );
        continue;
      }
      // Nested names are only dict keys; the top-level ones must also work as Python identifiers.
      if (depth === 1 && PYTHON_HARD_KEYWORDS.includes(name)) {
        report(problems, fieldPath, `"${name}" is a Python keyword and cannot be a field name`);
        // Still declared, so `required` does not also report it as missing.
        declared.add(name);
        continue;
      }
      declared.add(name);
      checkField(properties[name], fieldPath, depth + 1, problems);
    }
  }

  const required = own(record, 'required');
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every(entry => typeof entry === 'string')) {
      report(problems, join(path, 'required'), 'must be a list of field names');
    } else if (new Set(required).size !== required.length) {
      report(problems, join(path, 'required'), 'must list each field name only once');
    } else {
      required.forEach((entry, index) => {
        if (!declared.has(entry)) {
          report(problems, join(join(path, 'required'), index), `names "${entry}", which is not a field`);
        }
      });
    }
  }
}

function checkField(raw: unknown, path: string, depth: number, problems: FunctionContractProblem[]): void {
  if (!isPlainObject(raw)) {
    report(problems, path, 'must be an object describing a field');
    return;
  }
  if (depth > FUNCTION_CONTRACT_LIMITS.maxDepth) {
    report(problems, path, `is nested more than ${FUNCTION_CONTRACT_LIMITS.maxDepth} levels deep`);
    return;
  }
  const type = own(raw, 'type');
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
    report(problems, join(path, 'type'), `must be one of: ${FIELD_TYPES.join(', ')}`);
    return;
  }
  const fieldType = type as (typeof FIELD_TYPES)[number];
  const before = problems.length;
  refuseUnknownKeys(raw, [...COMMON_KEYS, ...ALLOWED_KEYS[fieldType]], path, problems);
  checkDescription(raw, path, problems);

  switch (fieldType) {
    case 'number':
    case 'integer':
      checkNumberField(raw, path, problems);
      break;
    case 'string':
      checkStringField(raw, path, problems);
      break;
    case 'array':
      checkArrayField(raw, path, depth, problems);
      break;
    case 'object':
      checkObjectField(raw, path, depth, problems);
      break;
    case 'boolean':
      break;
  }

  // A default is checked against the field only once the field itself is sound. A full list drops new problems,
  // so it cannot show that the field is sound.
  const defaultValue = own(raw, 'default');
  if (defaultValue !== undefined && problems.length === before && !isFull(problems)) {
    checkValue(raw as unknown as FunctionField, defaultValue, join(path, 'default'), problems);
  }
}

/**
 * Validate a contract read from guest code, collecting up to `maxProblems` problems; a contract is returned only
 * when there are none. A keyword outside the subset, such as `$ref` or `pattern`, is refused by name.
 */
export function parseFunctionContract(raw: unknown): FunctionContractParse {
  if (!isPlainObject(raw)) {
    return { ok: false, problems: [{ path: '', message: 'FUNCTION must be a dict' }] };
  }
  let size: number;
  try {
    size = functionJsonBytes(JSON.stringify(raw));
  } catch (error) {
    // Deep nesting overflows the stack in JSON.stringify; a cycle or a BigInt is a TypeError.
    const message =
      error instanceof RangeError ? 'FUNCTION is nested too deeply to read' : 'FUNCTION is not valid JSON';
    return { ok: false, problems: [{ path: '', message }] };
  }
  if (size > FUNCTION_CONTRACT_LIMITS.maxContractBytes) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message: `FUNCTION is ${size} bytes; at most ${FUNCTION_CONTRACT_LIMITS.maxContractBytes} are allowed`,
        },
      ],
    };
  }

  const problems: FunctionContractProblem[] = [];
  refuseUnknownKeys(raw, CONTRACT_KEYS, '', problems);

  const name = own(raw, 'name');
  if (typeof name !== 'string' || !FUNCTION_NAME_PATTERN.test(name)) {
    report(
      problems,
      'name',
      'must be 2 to 40 characters of lowercase letters, digits, and underscores, starting with a letter'
    );
  }
  const description = own(raw, 'description');
  if (
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > FUNCTION_CONTRACT_LIMITS.maxDescriptionLength
  ) {
    report(
      problems,
      'description',
      `must be non-empty text of at most ${FUNCTION_CONTRACT_LIMITS.maxDescriptionLength} characters`
    );
  }

  const sides: Record<'inputs' | 'outputs', FunctionObjectField | null> = { inputs: null, outputs: null };
  for (const side of ['inputs', 'outputs'] as const) {
    const field = own(raw, side);
    const before = problems.length;
    if (isPlainObject(field) && own(field, 'type') !== 'object') {
      report(problems, join(side, 'type'), 'must be "object"');
      continue;
    }
    checkField(field, side, 1, problems);
    if (problems.length === before && !isFull(problems)) sides[side] = field as unknown as FunctionObjectField;
  }
  const tests = own(raw, 'tests');
  if (tests !== undefined) checkTests(tests, sides.inputs, sides.outputs, problems);

  if (problems.length > 0 || !sides.inputs || !sides.outputs) {
    return { ok: false, problems: capFunctionProblems(problems) };
  }
  return {
    ok: true,
    contract: {
      name: name as string,
      description: description as string,
      inputs: sides.inputs,
      outputs: sides.outputs,
      ...(tests === undefined ? {} : { tests: tests as FunctionTestCase[] }),
    },
  };
}

/** Inputs are checked as a whole call; `expected` may name any of the outputs, each checked against its field. */
function checkTests(
  raw: unknown,
  inputs: FunctionObjectField | null,
  outputs: FunctionObjectField | null,
  problems: FunctionContractProblem[]
): void {
  const { maxTests, maxDescriptionLength } = FUNCTION_CONTRACT_LIMITS;
  if (!Array.isArray(raw)) return report(problems, 'tests', 'must be a list of test cases');
  if (raw.length > maxTests) {
    return report(problems, 'tests', `has ${raw.length} test cases; at most ${maxTests} are allowed`);
  }
  const names = new Set<string>();
  for (let index = 0; index < raw.length && !isFull(problems); index++) {
    const testCase: unknown = raw[index];
    const path = join('tests', index);
    if (!isPlainObject(testCase)) {
      report(problems, path, 'must be an object with name, input, and expected');
      continue;
    }
    refuseUnknownKeys(testCase, TEST_CASE_KEYS, path, problems);
    const name = own(testCase, 'name');
    if (typeof name !== 'string' || !name.trim() || name.length > maxDescriptionLength) {
      report(problems, join(path, 'name'), `must be non-empty text of at most ${maxDescriptionLength} characters`);
    } else if (names.has(name)) {
      report(problems, join(path, 'name'), `repeats the test name "${name}"; each test needs its own`);
    } else {
      names.add(name);
    }
    const input = own(testCase, 'input');
    if (!isPlainObject(input)) report(problems, join(path, 'input'), 'must be an object of input values');
    else if (inputs) checkObjectValue(inputs, input, join(path, 'input'), problems);

    const expected = own(testCase, 'expected');
    if (!isPlainObject(expected) || Object.keys(expected).length === 0) {
      report(problems, join(path, 'expected'), 'must be an object naming at least one output');
    } else if (outputs) {
      for (const key of Object.keys(expected)) {
        const field = own(outputs.properties, key) as FunctionField | undefined;
        const fieldPath = join(join(path, 'expected'), key);
        if (field) checkValue(field, expected[key], fieldPath, problems);
        else report(problems, fieldPath, 'is not an output of the contract');
      }
    }

    const tolerance = own(testCase, 'tolerance');
    if (tolerance === undefined) continue;
    if (!isPlainObject(tolerance)) {
      report(problems, join(path, 'tolerance'), 'must be an object with abs, rel, or both');
      continue;
    }
    refuseUnknownKeys(tolerance, TOLERANCE_KEYS, join(path, 'tolerance'), problems);
    for (const key of TOLERANCE_KEYS) {
      const value = own(tolerance, key);
      if (value !== undefined && !(isFiniteNumber(value) && value >= 0)) {
        report(problems, join(join(path, 'tolerance'), key), 'must be a number of 0 or more');
      }
    }
  }
}

function checkValue(field: FunctionField, value: unknown, path: string, problems: FunctionContractProblem[]): void {
  switch (field.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number') return report(problems, path, 'must be a number');
      if (!Number.isFinite(value)) return report(problems, path, 'must be a finite number');
      if (field.type === 'integer' && !Number.isInteger(value)) return report(problems, path, 'must be a whole number');
      if (field.minimum !== undefined && value < field.minimum) {
        report(problems, path, `must be at least ${field.minimum}`);
      }
      if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) {
        report(problems, path, `must be greater than ${field.exclusiveMinimum}`);
      }
      if (field.maximum !== undefined && value > field.maximum) {
        report(problems, path, `must be at most ${field.maximum}`);
      }
      if (field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum) {
        report(problems, path, `must be less than ${field.exclusiveMaximum}`);
      }
      if (field.enum && !field.enum.includes(value)) report(problems, path, enumMessage(field.enum));
      return;
    }
    case 'string': {
      if (typeof value !== 'string') return report(problems, path, 'must be text');
      const maxLength = field.maxLength ?? FUNCTION_CONTRACT_LIMITS.maxStringLength;
      if (value.length > maxLength) {
        report(problems, path, `must be at most ${maxLength} characters (it has ${value.length})`);
      }
      if (field.enum && !field.enum.includes(value)) report(problems, path, enumMessage(field.enum));
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') report(problems, path, 'must be true or false');
      return;
    case 'array': {
      if (!Array.isArray(value)) return report(problems, path, 'must be a list');
      if (field.minItems !== undefined && value.length < field.minItems) {
        report(problems, path, `must have at least ${field.minItems} items`);
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        report(problems, path, `must have at most ${field.maxItems} items`);
      }
      for (let index = 0; index < value.length && !isFull(problems); index++) {
        checkValue(field.items, value[index], join(path, index), problems);
      }
      return;
    }
    case 'object':
      return checkObjectValue(field, value, path, problems);
  }
}

function checkObjectValue(
  schema: FunctionObjectField,
  value: unknown,
  path: string,
  problems: FunctionContractProblem[]
): void {
  if (!isPlainObject(value)) return report(problems, path, 'must be an object');
  for (const name of schema.required ?? []) {
    if (own(value, name) === undefined) report(problems, join(path, name), 'is required');
  }
  for (const name of Object.keys(value)) {
    if (isFull(problems)) return;
    const field = own(schema.properties, name) as FunctionField | undefined;
    if (!field) {
      report(problems, join(path, name), 'is not part of the contract');
      continue;
    }
    checkValue(field, value[name], join(path, name), problems);
  }
}

/**
 * Check a value against an object field of a contract that `parseFunctionContract` accepted. Paths
 * are relative to the value, such as `span` or `points.2.x`. Stops after `maxProblems` problems.
 */
export function validateFunctionValue(schema: FunctionObjectField, value: unknown): FunctionContractProblem[] {
  const problems: FunctionContractProblem[] = [];
  checkObjectValue(schema, value, '', problems);
  return capFunctionProblems(problems);
}

export interface FunctionOutputMismatch {
  /** Path in the output, such as `deflection` or `supports.1.moment`. */
  path: string;
  expected: unknown;
  /** Undefined when `run` left the field out. */
  actual: unknown;
}

/**
 * The first place `actual` differs from `expected`, or null when they match. Only the fields `expected` names are
 * compared: numbers within `tolerance`, text and true or false exactly, lists item by item; NaN or an infinity never
 * matches.
 */
export function compareFunctionOutput(
  expected: Record<string, unknown>,
  actual: unknown,
  tolerance: FunctionTestTolerance = {}
): FunctionOutputMismatch | null {
  return compareValue(expected, actual, '', tolerance);
}

function compareValue(
  expected: unknown,
  actual: unknown,
  path: string,
  tolerance: FunctionTestTolerance
): FunctionOutputMismatch | null {
  const mismatch = { path, expected, actual };
  if (typeof expected === 'number') {
    if (typeof actual !== 'number' || !Number.isFinite(expected) || !Number.isFinite(actual)) return mismatch;
    const difference = Math.abs(actual - expected);
    const within = difference <= (tolerance.abs ?? 0) || difference <= (tolerance.rel ?? 0) * Math.abs(expected);
    return within ? null : mismatch;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return mismatch;
    for (let index = 0; index < expected.length; index++) {
      const found = compareValue(expected[index], actual[index], join(path, index), tolerance);
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return mismatch;
    for (const key of Object.keys(expected)) {
      const found = compareValue(expected[key], own(actual, key), join(path, key), tolerance);
      if (found) return found;
    }
    return null;
  }
  return expected === actual ? null : mismatch;
}

export type FunctionContractChangeKind =
  | 'name_changed'
  | 'description_changed'
  | 'removed'
  | 'added'
  | 'added_required'
  | 'type_changed'
  | 'unit_changed'
  | 'enum_value_removed'
  | 'enum_value_added'
  | 'enum_added'
  | 'enum_removed'
  | 'newly_required'
  | 'no_longer_required'
  | 'bounds_narrowed'
  | 'bounds_widened'
  | 'default_changed';

export interface FunctionContractChange {
  /** Readable path such as `inputs.load.unit`; list items read `points[]`. */
  path: string;
  /** Null for the contract's own name and description. */
  side: 'inputs' | 'outputs' | null;
  /** The field changed, such as `load` or `points[].x`; empty for the contract or a side as a whole. */
  field: string;
  kind: FunctionContractChangeKind;
  before?: string;
  after?: string;
}

export interface FunctionContractDiff {
  breaking: FunctionContractChange[];
  compatible: FunctionContractChange[];
}

interface DiffContext {
  side: 'inputs' | 'outputs';
  diff: FunctionContractDiff;
}

function addChange(
  ctx: DiffContext,
  field: string,
  keyword: string,
  kind: FunctionContractChangeKind,
  breaking: boolean,
  before?: string,
  after?: string
): void {
  const path = [ctx.side, field, keyword].filter(Boolean).join('.');
  const change: FunctionContractChange = { path, side: ctx.side, field, kind };
  if (before !== undefined) change.before = before;
  if (after !== undefined) change.after = after;
  (breaking ? ctx.diff.breaking : ctx.diff.compatible).push(change);
}

/**
 * A caller of an input may now be refused when the accepted values narrow; a caller of an output may now receive a
 * value it was told it would not when the returned values widen.
 * Removals and type changes skip this rule: both are breaking on either side by rule of thumb, not by variance.
 */
function breaksCallers(ctx: DiffContext, narrows: boolean): boolean {
  return ctx.side === 'inputs' ? narrows : !narrows;
}

function addRangeChange(
  ctx: DiffContext,
  field: string,
  keyword: string,
  narrows: boolean,
  before: string,
  after: string
): void {
  addChange(
    ctx,
    field,
    keyword,
    narrows ? 'bounds_narrowed' : 'bounds_widened',
    breaksCallers(ctx, narrows),
    before,
    after
  );
}

function tighterBound(a: FunctionBound | null, b: FunctionBound | null, direction: 1 | -1): boolean {
  if (a === null) return false;
  if (b === null) return true;
  if (a.value !== b.value) return direction * (a.value - b.value) > 0;
  return a.exclusive && !b.exclusive;
}

/** The binding lower (`direction` 1) or upper (-1) bound of a number field; null when it has none. */
function numberBound(field: FunctionNumberField, direction: 1 | -1): FunctionBound | null {
  const [inclusive, exclusive] =
    direction === 1 ? [field.minimum, field.exclusiveMinimum] : [field.maximum, field.exclusiveMaximum];
  const candidates: FunctionBound[] = [
    ...(inclusive === undefined ? [] : [{ value: inclusive, exclusive: false }]),
    ...(exclusive === undefined ? [] : [{ value: exclusive, exclusive: true }]),
  ];
  let bound = candidates.reduce<FunctionBound | null>(
    (best, next) => (tighterBound(next, best, direction) ? next : best),
    null
  );
  // Past 2^53 whole numbers are not exact, so `Math.floor(v) + 1 === v`; there the exclusive tie-break decides.
  if (bound && field.type === 'integer' && Math.abs(bound.value) < Number.MAX_SAFE_INTEGER) {
    bound = { value: direction === 1 ? lowestWhole(bound) : highestWhole(bound), exclusive: false };
  }
  return bound;
}

function boundText(bound: FunctionBound | null, direction: 1 | -1): string {
  if (bound === null) return direction === 1 ? 'no lower bound' : 'no upper bound';
  if (direction === 1) return `${bound.exclusive ? 'more than' : 'at least'} ${bound.value}`;
  return `${bound.exclusive ? 'less than' : 'at most'} ${bound.value}`;
}

// Case stays significant: `kN` and `KN` are different units.
const unitOf = (field: FunctionNumberField) => field.unit.replace(/\s+/g, ' ').trim();

function diffNumberField(ctx: DiffContext, prev: FunctionNumberField, next: FunctionNumberField, field: string) {
  const [unitBefore, unitAfter] = [unitOf(prev), unitOf(next)];
  if (unitBefore !== unitAfter) addChange(ctx, field, 'unit', 'unit_changed', true, unitBefore, unitAfter);
  for (const [direction, keyword] of [
    [1, 'minimum'],
    [-1, 'maximum'],
  ] as const) {
    const before = numberBound(prev, direction);
    const after = numberBound(next, direction);
    if (!tighterBound(after, before, direction) && !tighterBound(before, after, direction)) continue;
    addRangeChange(
      ctx,
      field,
      keyword,
      tighterBound(after, before, direction),
      boundText(before, direction),
      boundText(after, direction)
    );
  }
}

function diffEnum(
  ctx: DiffContext,
  prev: readonly (string | number)[] | undefined,
  next: readonly (string | number)[] | undefined,
  field: string
): void {
  if (!prev && !next) return;
  if (!prev || !next) {
    if (next) addChange(ctx, field, 'enum', 'enum_added', breaksCallers(ctx, true), undefined, next.join(', '));
    else addChange(ctx, field, 'enum', 'enum_removed', breaksCallers(ctx, false), prev?.join(', '));
    return;
  }
  for (const value of prev) {
    if (!next.includes(value)) {
      addChange(ctx, field, 'enum', 'enum_value_removed', breaksCallers(ctx, true), String(value));
    }
  }
  for (const value of next) {
    if (!prev.includes(value)) {
      addChange(ctx, field, 'enum', 'enum_value_added', breaksCallers(ctx, false), undefined, String(value));
    }
  }
}

function diffCount(
  ctx: DiffContext,
  field: string,
  keyword: string,
  before: number | undefined,
  after: number | undefined,
  direction: 1 | -1,
  text: (count: number | undefined) => string
): void {
  const unbounded = direction === 1 ? 0 : Infinity;
  const was = before ?? unbounded;
  const now = after ?? unbounded;
  if (was === now) return;
  addRangeChange(ctx, field, keyword, direction * (now - was) > 0, text(before), text(after));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const defaultOf = (field: FunctionField): unknown =>
  field.type === 'array' || field.type === 'object' ? undefined : field.default;

function diffField(ctx: DiffContext, prev: FunctionField, next: FunctionField, field: string): void {
  if (prev.type !== next.type) {
    addChange(ctx, field, 'type', 'type_changed', true, prev.type, next.type);
    return;
  }
  if ((prev.description ?? '') !== (next.description ?? '')) {
    addChange(ctx, field, 'description', 'description_changed', false);
  }
  const before = defaultOf(prev);
  const after = defaultOf(next);
  if (before !== after) {
    const text = (value: unknown) => (value === undefined ? undefined : JSON.stringify(value));
    // A default only fills an omitted optional input, so no caller is refused and no output leaves its contract.
    addChange(ctx, field, 'default', 'default_changed', false, text(before), text(after));
  }

  switch (prev.type) {
    case 'number':
    case 'integer': {
      const nextNumber = next as FunctionNumberField;
      diffNumberField(ctx, prev, nextNumber, field);
      diffEnum(ctx, prev.enum, nextNumber.enum, field);
      return;
    }
    case 'string': {
      const nextString = next as FunctionStringField;
      diffEnum(ctx, prev.enum, nextString.enum, field);
      const max = FUNCTION_CONTRACT_LIMITS.maxStringLength;
      diffCount(
        ctx,
        field,
        'maxLength',
        prev.maxLength ?? max,
        nextString.maxLength ?? max,
        -1,
        count => `at most ${plural(count ?? 0, 'character')}`
      );
      return;
    }
    case 'array': {
      const nextArray = next as FunctionArrayField;
      diffCount(
        ctx,
        field,
        'minItems',
        prev.minItems,
        nextArray.minItems,
        1,
        count => `at least ${plural(count ?? 0, 'item')}`
      );
      diffCount(ctx, field, 'maxItems', prev.maxItems, nextArray.maxItems, -1, count =>
        count === undefined ? 'any number of items' : `at most ${plural(count, 'item')}`
      );
      diffField(ctx, prev.items, nextArray.items, `${field}[]`);
      return;
    }
    case 'object':
      diffObjectField(ctx, prev, next as FunctionObjectField, field);
      return;
    case 'boolean':
      return;
  }
}

function diffObjectField(ctx: DiffContext, prev: FunctionObjectField, next: FunctionObjectField, prefix: string) {
  const wasRequired = new Set(prev.required ?? []);
  const isRequired = new Set(next.required ?? []);
  const inputs = ctx.side === 'inputs';
  for (const name of Object.keys(prev.properties)) {
    const field = prefix ? `${prefix}.${name}` : name;
    const nextField = own(next.properties, name) as FunctionField | undefined;
    if (!nextField) {
      addChange(ctx, field, '', 'removed', true);
      continue;
    }
    if (wasRequired.has(name) !== isRequired.has(name)) {
      const nowRequired = isRequired.has(name);
      // Required narrows what an input accepts and widens what an output may leave out.
      addChange(
        ctx,
        field,
        '',
        nowRequired ? 'newly_required' : 'no_longer_required',
        inputs ? nowRequired : !nowRequired
      );
    }
    diffField(ctx, prev.properties[name], nextField, field);
  }
  for (const name of Object.keys(next.properties)) {
    if (own(prev.properties, name) !== undefined) continue;
    const field = prefix ? `${prefix}.${name}` : name;
    const required = inputs && isRequired.has(name);
    // Objects are closed (additionalProperties: false), so a caller checking a result against the old outputs
    // refuses any new key, optional or not.
    addChange(ctx, field, '', required ? 'added_required' : 'added', required || !inputs);
  }
}

/**
 * The changes from `previous` to `next`, split by whether a caller written against `previous` could now be refused
 * or receive a value it was told it would not. A renamed field reads as a removal and an addition. Null when either
 * side does not parse (a stored contract from an older shape, say), so the two cannot be compared.
 */
export function diffFunctionContracts(rawPrevious: unknown, rawNext: unknown): FunctionContractDiff | null {
  const parsedPrevious = parseFunctionContract(rawPrevious);
  const parsedNext = parseFunctionContract(rawNext);
  if (!parsedPrevious.ok || !parsedNext.ok) return null;
  const [previous, next] = [parsedPrevious.contract, parsedNext.contract];
  const diff: FunctionContractDiff = { breaking: [], compatible: [] };
  if (previous.name !== next.name) {
    diff.breaking.push({
      path: 'name',
      side: null,
      field: '',
      kind: 'name_changed',
      before: previous.name,
      after: next.name,
    });
  }
  if (previous.description !== next.description) {
    diff.compatible.push({ path: 'description', side: null, field: '', kind: 'description_changed' });
  }
  for (const side of ['inputs', 'outputs'] as const) {
    diffField({ side, diff }, previous[side], next[side], '');
  }
  return diff;
}

function changeWords(change: FunctionContractChange): string {
  const { before, after } = change;
  const inputs = change.side === 'inputs';
  switch (change.kind) {
    case 'name_changed':
      return `changed name from ${before} to ${after}`;
    case 'description_changed':
      return 'changed its description';
    case 'removed':
      return 'was removed';
    case 'added':
      return 'was added';
    case 'added_required':
      return 'was added as a required input';
    case 'type_changed':
      return `changed type from ${before} to ${after}`;
    case 'unit_changed':
      return `changed unit from ${before} to ${after}`;
    case 'enum_value_removed':
      return inputs ? `no longer accepts ${before}` : `no longer returns ${before}`;
    case 'enum_value_added':
      return inputs ? `now accepts ${after}` : `can now return ${after}`;
    case 'enum_added':
      return inputs ? `now accepts only ${after}` : `now returns only ${after}`;
    case 'enum_removed':
      return inputs ? `now accepts any value, not only ${before}` : `can now return any value, not only ${before}`;
    case 'newly_required':
      return inputs ? 'is now required' : 'is now always returned';
    case 'no_longer_required':
      return inputs ? 'is no longer required' : 'is no longer always returned';
    case 'bounds_narrowed':
      return `narrowed from ${before} to ${after}`;
    case 'bounds_widened':
      return `widened from ${before} to ${after}`;
    case 'default_changed':
      if (before === undefined) return `now defaults to ${after}`;
      if (after === undefined) return 'no longer has a default';
      return `changed its default from ${before} to ${after}`;
  }
}

/**
 * A change in plain words, split so a view can set the field apart: `subject` reads `output`, `input`, `the
 * outputs`, or `the function`, and the sentence is `${subject} ${field} ${words}` without the empty field.
 */
export function describeFunctionContractChange(change: FunctionContractChange): {
  subject: string;
  field: string;
  words: string;
} {
  const subject =
    change.side === null ? 'the function' : change.field ? change.side.slice(0, -1) : `the ${change.side}`;
  return { subject, field: change.field, words: changeWords(change) };
}
