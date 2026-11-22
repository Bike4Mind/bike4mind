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

export const FUNCTION_CONTRACT_LIMITS = {
  maxProperties: 40,
  maxDepth: 4,
  maxEnumValues: 50,
  maxDescriptionLength: 500,
  maxStringLength: 2000,
  maxContractBytes: 32 * 1024,
  maxTests: 50,
  maxResultBytes: 256 * 1024,
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

export interface FunctionTestCase {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  tolerance?: { abs?: number; rel?: number };
}

export interface FunctionContract {
  name: string;
  description: string;
  inputs: FunctionObjectField;
  outputs: FunctionObjectField;
  tests: FunctionTestCase[];
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
const TOLERANCE_KEYS = ['abs', 'rel'];

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

function refuseUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: FunctionContractProblem[]
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) problems.push({ path: join(path, key), message: `"${key}" is not supported` });
  }
}

function checkDescription(record: Record<string, unknown>, path: string, problems: FunctionContractProblem[]): void {
  const description = own(record, 'description');
  if (description === undefined) return;
  if (typeof description !== 'string' || description.length > FUNCTION_CONTRACT_LIMITS.maxDescriptionLength) {
    problems.push({
      path: join(path, 'description'),
      message: `must be text of at most ${FUNCTION_CONTRACT_LIMITS.maxDescriptionLength} characters`,
    });
  }
}

function checkNumberField(record: Record<string, unknown>, path: string, problems: FunctionContractProblem[]): void {
  const unit = own(record, 'unit');
  if (unit === undefined) {
    problems.push({
      path: join(path, 'unit'),
      message: `a number field needs a unit (use "${DIMENSIONLESS_UNIT}" for a value without one)`,
    });
  } else if (typeof unit !== 'string' || !FUNCTION_UNIT_PATTERN.test(unit)) {
    problems.push({
      path: join(path, 'unit'),
      message: 'may use only letters, digits, spaces, and % ^ * / . ( ) -, up to 32 characters',
    });
  }

  const bounds = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const;
  for (const key of bounds) {
    const bound = own(record, key);
    if (bound !== undefined && !isFiniteNumber(bound)) {
      problems.push({ path: join(path, key), message: 'must be a finite number' });
    }
  }
  const lowers = [own(record, 'minimum'), own(record, 'exclusiveMinimum')].filter(isFiniteNumber);
  const uppers = [own(record, 'maximum'), own(record, 'exclusiveMaximum')].filter(isFiniteNumber);
  if (lowers.length > 0 && uppers.length > 0 && Math.max(...lowers) > Math.min(...uppers)) {
    problems.push({ path: join(path, 'minimum'), message: 'the lower bound is greater than the upper bound' });
  }

  const values = own(record, 'enum');
  if (values !== undefined) {
    const whole = record.type === 'integer';
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > FUNCTION_CONTRACT_LIMITS.maxEnumValues ||
      !values.every(v => isFiniteNumber(v) && (!whole || Number.isInteger(v)))
    ) {
      problems.push({
        path: join(path, 'enum'),
        message: `must list 1 to ${FUNCTION_CONTRACT_LIMITS.maxEnumValues} ${whole ? 'whole numbers' : 'numbers'}`,
      });
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
    problems.push({
      path: join(path, 'enum'),
      message: `must list 1 to ${FUNCTION_CONTRACT_LIMITS.maxEnumValues} text values`,
    });
  }
  const maxLength = own(record, 'maxLength');
  if (maxLength !== undefined && (!isCount(maxLength) || maxLength > FUNCTION_CONTRACT_LIMITS.maxStringLength)) {
    problems.push({
      path: join(path, 'maxLength'),
      message: `must be a whole number from 0 to ${FUNCTION_CONTRACT_LIMITS.maxStringLength}`,
    });
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
    problems.push({ path: join(path, 'items'), message: 'a list field needs an items schema' });
  } else {
    checkField(items, join(path, 'items'), depth + 1, problems);
  }
  for (const key of ['minItems', 'maxItems'] as const) {
    const count = own(record, key);
    if (count !== undefined && !isCount(count)) {
      problems.push({ path: join(path, key), message: 'must be a whole number of 0 or more' });
    }
  }
  const minItems = own(record, 'minItems');
  const maxItems = own(record, 'maxItems');
  if (isCount(minItems) && isCount(maxItems) && minItems > maxItems) {
    problems.push({ path: join(path, 'minItems'), message: 'is greater than maxItems' });
  }
}

function checkObjectField(
  record: Record<string, unknown>,
  path: string,
  depth: number,
  problems: FunctionContractProblem[]
): void {
  if (own(record, 'additionalProperties') !== false) {
    problems.push({ path: join(path, 'additionalProperties'), message: 'must be false' });
  }

  const properties = own(record, 'properties');
  const declared = new Set<string>();
  if (!isPlainObject(properties)) {
    problems.push({ path: join(path, 'properties'), message: 'must be an object of fields' });
  } else {
    const names = Object.keys(properties);
    if (names.length > FUNCTION_CONTRACT_LIMITS.maxProperties) {
      problems.push({
        path: join(path, 'properties'),
        message: `has ${names.length} fields; at most ${FUNCTION_CONTRACT_LIMITS.maxProperties} are allowed`,
      });
    }
    for (const name of names) {
      const fieldPath = join(join(path, 'properties'), name);
      if (!FUNCTION_PROPERTY_NAME_PATTERN.test(name)) {
        problems.push({
          path: fieldPath,
          message: 'a field name must start with a letter or underscore and use only letters, digits, and underscores',
        });
        continue;
      }
      declared.add(name);
      checkField(properties[name], fieldPath, depth + 1, problems);
    }
  }

  const required = own(record, 'required');
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every(entry => typeof entry === 'string')) {
      problems.push({ path: join(path, 'required'), message: 'must be a list of field names' });
    } else {
      required.forEach((entry, index) => {
        if (!declared.has(entry)) {
          problems.push({
            path: join(join(path, 'required'), index),
            message: `names "${entry}", which is not a field`,
          });
        }
      });
    }
  }
}

function checkField(raw: unknown, path: string, depth: number, problems: FunctionContractProblem[]): void {
  if (!isPlainObject(raw)) {
    problems.push({ path, message: 'must be an object describing a field' });
    return;
  }
  if (depth > FUNCTION_CONTRACT_LIMITS.maxDepth) {
    problems.push({ path, message: `is nested more than ${FUNCTION_CONTRACT_LIMITS.maxDepth} levels deep` });
    return;
  }
  const type = own(raw, 'type');
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
    problems.push({ path: join(path, 'type'), message: `must be one of: ${FIELD_TYPES.join(', ')}` });
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

  // A default is checked against the field only once the field itself is sound.
  const defaultValue = own(raw, 'default');
  if (defaultValue !== undefined && problems.length === before) {
    for (const problem of checkValue(raw as unknown as FunctionField, defaultValue, '')) {
      problems.push({ path: join(path, 'default'), message: problem.message });
    }
  }
}

function checkTests(raw: unknown, inputs: FunctionObjectField | null, problems: FunctionContractProblem[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    problems.push({ path: 'tests', message: 'must be a list of test cases' });
    return;
  }
  if (raw.length > FUNCTION_CONTRACT_LIMITS.maxTests) {
    problems.push({
      path: 'tests',
      message: `has ${raw.length} test cases; at most ${FUNCTION_CONTRACT_LIMITS.maxTests} are allowed`,
    });
    return;
  }
  raw.forEach((testCase, index) => {
    const path = join('tests', index);
    if (!isPlainObject(testCase)) {
      problems.push({ path, message: 'must be an object with name, input, and expected' });
      return;
    }
    refuseUnknownKeys(testCase, TEST_CASE_KEYS, path, problems);
    const name = own(testCase, 'name');
    if (typeof name !== 'string' || !name.trim() || name.length > FUNCTION_CONTRACT_LIMITS.maxDescriptionLength) {
      problems.push({ path: join(path, 'name'), message: 'must be a non-empty name' });
    }
    const input = own(testCase, 'input');
    if (!isPlainObject(input)) {
      problems.push({ path: join(path, 'input'), message: 'must be an object of input values' });
    } else if (inputs) {
      for (const problem of validateFunctionValue(inputs, input)) {
        problems.push({ path: join(join(path, 'input'), problem.path), message: problem.message });
      }
    }
    if (!isPlainObject(own(testCase, 'expected'))) {
      problems.push({ path: join(path, 'expected'), message: 'must be an object of expected values' });
    }
    const tolerance = own(testCase, 'tolerance');
    if (tolerance !== undefined) {
      if (!isPlainObject(tolerance)) {
        problems.push({ path: join(path, 'tolerance'), message: 'must be an object with abs or rel' });
      } else {
        refuseUnknownKeys(tolerance, TOLERANCE_KEYS, join(path, 'tolerance'), problems);
        for (const key of TOLERANCE_KEYS) {
          const value = own(tolerance, key);
          if (value !== undefined && !(isFiniteNumber(value) && value >= 0)) {
            problems.push({ path: join(join(path, 'tolerance'), key), message: 'must be a number of 0 or more' });
          }
        }
      }
    }
  });
}

/**
 * Validate a contract read from guest code, collecting every problem; a contract is returned only when there are
 * none. A keyword outside the subset, such as `$ref` or `pattern`, is refused by name rather than ignored.
 */
export function parseFunctionContract(raw: unknown): FunctionContractParse {
  if (!isPlainObject(raw)) {
    return { ok: false, problems: [{ path: '', message: 'FUNCTION must be a dict' }] };
  }
  let size: number;
  try {
    size = functionJsonBytes(JSON.stringify(raw));
  } catch {
    return { ok: false, problems: [{ path: '', message: 'FUNCTION is not valid JSON' }] };
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
    problems.push({
      path: 'name',
      message: 'must be 2 to 40 characters of lowercase letters, digits, and underscores, starting with a letter',
    });
  }
  const description = own(raw, 'description');
  if (
    typeof description !== 'string' ||
    !description.trim() ||
    description.length > FUNCTION_CONTRACT_LIMITS.maxDescriptionLength
  ) {
    problems.push({
      path: 'description',
      message: `must be non-empty text of at most ${FUNCTION_CONTRACT_LIMITS.maxDescriptionLength} characters`,
    });
  }

  const sides: Record<'inputs' | 'outputs', FunctionObjectField | null> = { inputs: null, outputs: null };
  for (const side of ['inputs', 'outputs'] as const) {
    const field = own(raw, side);
    const before = problems.length;
    if (isPlainObject(field) && own(field, 'type') !== 'object') {
      problems.push({ path: join(side, 'type'), message: 'must be "object"' });
      continue;
    }
    checkField(field, side, 1, problems);
    if (problems.length === before) sides[side] = field as unknown as FunctionObjectField;
  }

  checkTests(own(raw, 'tests'), sides.inputs, problems);

  if (problems.length > 0 || !sides.inputs || !sides.outputs) return { ok: false, problems };
  return {
    ok: true,
    contract: {
      name: name as string,
      description: description as string,
      inputs: sides.inputs,
      outputs: sides.outputs,
      tests: (own(raw, 'tests') as FunctionTestCase[] | undefined) ?? [],
    },
  };
}

function checkValue(field: FunctionField, value: unknown, path: string): FunctionContractProblem[] {
  const problems: FunctionContractProblem[] = [];
  switch (field.type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number') return [{ path, message: 'must be a number' }];
      if (!Number.isFinite(value)) return [{ path, message: 'must be a finite number' }];
      if (field.type === 'integer' && !Number.isInteger(value)) return [{ path, message: 'must be a whole number' }];
      if (field.minimum !== undefined && value < field.minimum) {
        problems.push({ path, message: `must be at least ${field.minimum}` });
      }
      if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) {
        problems.push({ path, message: `must be greater than ${field.exclusiveMinimum}` });
      }
      if (field.maximum !== undefined && value > field.maximum) {
        problems.push({ path, message: `must be at most ${field.maximum}` });
      }
      if (field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum) {
        problems.push({ path, message: `must be less than ${field.exclusiveMaximum}` });
      }
      if (field.enum && !field.enum.includes(value)) {
        problems.push({ path, message: `must be one of: ${field.enum.join(', ')}` });
      }
      return problems;
    }
    case 'string': {
      if (typeof value !== 'string') return [{ path, message: 'must be text' }];
      const maxLength = field.maxLength ?? FUNCTION_CONTRACT_LIMITS.maxStringLength;
      if (value.length > maxLength) problems.push({ path, message: `must be at most ${maxLength} characters` });
      if (field.enum && !field.enum.includes(value)) {
        problems.push({ path, message: `must be one of: ${field.enum.join(', ')}` });
      }
      return problems;
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [{ path, message: 'must be true or false' }];
    case 'array': {
      if (!Array.isArray(value)) return [{ path, message: 'must be a list' }];
      if (field.minItems !== undefined && value.length < field.minItems) {
        problems.push({ path, message: `must have at least ${field.minItems} items` });
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        problems.push({ path, message: `must have at most ${field.maxItems} items` });
      }
      value.forEach((item, index) => problems.push(...checkValue(field.items, item, join(path, index))));
      return problems;
    }
    case 'object':
      return checkObjectValue(field, value, path);
  }
}

function checkObjectValue(schema: FunctionObjectField, value: unknown, path: string): FunctionContractProblem[] {
  if (!isPlainObject(value)) return [{ path, message: 'must be an object' }];
  const problems: FunctionContractProblem[] = [];
  for (const name of schema.required ?? []) {
    if (own(value, name) === undefined) problems.push({ path: join(path, name), message: 'is required' });
  }
  for (const name of Object.keys(value)) {
    const field = own(schema.properties, name) as FunctionField | undefined;
    if (!field) {
      problems.push({ path: join(path, name), message: 'is not part of the contract' });
      continue;
    }
    problems.push(...checkValue(field, value[name], join(path, name)));
  }
  return problems;
}

/**
 * Check a value against an object field of a contract that `parseFunctionContract` accepted. Paths
 * are relative to the value, such as `span` or `points.2.x`.
 */
export function validateFunctionValue(schema: FunctionObjectField, value: unknown): FunctionContractProblem[] {
  return checkObjectValue(schema, value, '');
}
