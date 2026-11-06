import { z } from 'zod';
import {
  AbuseAssessmentConfigSchema,
  AutoContainmentConfigSchema,
  UsagePatternSignalsConfigSchema,
} from '@bike4mind/common';

export type ConfigObject = Record<string, unknown>;
export type FieldPath = readonly string[];

type FieldBase = { key: string; path: FieldPath; label: string; help?: string };
export type FieldSpec =
  | (FieldBase & { kind: 'enum'; options: readonly string[]; nullable: boolean })
  | (FieldBase & { kind: 'number'; integer: boolean; min?: number; max?: number; exclusiveMin?: number })
  | (FieldBase & { kind: 'boolean' })
  | (FieldBase & { kind: 'group'; fields: FieldSpec[] })
  // A shape this form has no control for; it stays editable through the JSON view.
  | (FieldBase & { kind: 'unsupported' });

type JsonSchemaNode = z.core.JSONSchema.JSONSchema;

/**
 * A structured admin setting edited by the generated form. The server parses the saved value
 * with the same schema (makeObjectSetting in b4m-core/common/src/schemas/settings.ts), so these
 * must stay the exact schemas the settings map declares.
 */
export type StructuredSetting = {
  schema: z.ZodObject;
  /** Plain-language consequences the admin confirms before saving `next` over `stored`. */
  confirmations?(next: ConfigObject, stored: ConfigObject): string[];
};

export const STRUCTURED_SETTINGS: Record<string, StructuredSetting> = {
  abuseAssessmentConfig: { schema: AbuseAssessmentConfigSchema },
  usagePatternSignalsConfig: { schema: UsagePatternSignalsConfigSchema },
  autoContainmentConfig: {
    schema: AutoContainmentConfigSchema,
    confirmations: (next, stored) => [
      ...(next.mode === 'enforce' && stored.mode !== 'enforce'
        ? [
            'Mode enforce contains real accounts: each one judged abuse is suspended, its Stripe subscriptions canceled, its positive balance removed, its API keys revoked and its sessions ended. Unsuspend reverses only the suspension.',
          ]
        : []),
      ...(next.blockEmailDomains === true && stored.blockEmailDomains !== true
        ? [
            "Block email domains adds each contained account's own email domain to blockedEmailDomains, refusing every new signup on it. One false positive on a shared company or campus domain blocks the whole domain.",
          ]
        : []),
    ],
  },
};

export const getStructuredSetting = (key: string): StructuredSetting | undefined =>
  Object.hasOwn(STRUCTURED_SETTINGS, key) ? STRUCTURED_SETTINGS[key] : undefined;

const isNode = (node: unknown): node is JsonSchemaNode => typeof node === 'object' && node !== null;

const humanize = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The enum options of a `{ type: 'string', enum }` node, if that is what it is. */
const enumOptions = (node: JsonSchemaNode): string[] | undefined =>
  Array.isArray(node.enum) && node.enum.every(option => typeof option === 'string') ? node.enum : undefined;

// z.number().int() reports the safe-integer range as its bounds; those are not limits worth showing.
// exclusiveMinimum is typed number | boolean for older JSON Schema drafts; Zod emits only numbers.
const realBound = (bound: unknown) =>
  typeof bound === 'number' && Math.abs(bound) < Number.MAX_SAFE_INTEGER ? bound : undefined;

function describeNode(key: string, path: FieldPath, node: JsonSchemaNode): FieldSpec {
  const base: FieldBase = { key, path, label: node.title ?? humanize(key), help: node.description };
  const variants = (node.anyOf ?? []).filter(isNode);
  const nullable = variants.some(variant => variant.type === 'null');
  const valueVariants = variants.filter(variant => variant.type !== 'null');
  const valueNode = valueVariants.length === 1 ? valueVariants[0] : node;

  const options = enumOptions(valueNode);
  if (options) return { ...base, kind: 'enum', options, nullable };
  if (nullable) return { ...base, kind: 'unsupported' };
  if (node.type === 'boolean') return { ...base, kind: 'boolean' };
  if (node.type === 'number' || node.type === 'integer') {
    return {
      ...base,
      kind: 'number',
      integer: node.type === 'integer',
      min: realBound(node.minimum),
      max: realBound(node.maximum),
      exclusiveMin: realBound(node.exclusiveMinimum),
    };
  }
  if (node.type === 'object' && isNode(node.properties)) {
    return { ...base, kind: 'group', fields: describeProperties(node.properties, path) };
  }
  return { ...base, kind: 'unsupported' };
}

function describeProperties(properties: Record<string, unknown>, parent: FieldPath): FieldSpec[] {
  return Object.entries(properties).map(([key, node]) =>
    isNode(node)
      ? describeNode(key, [...parent, key], node)
      : { key, path: [...parent, key], label: humanize(key), kind: 'unsupported' }
  );
}

/** The form fields for an object schema, in declaration order, read from its JSON Schema (input side). */
export function describeFields(schema: z.ZodObject): FieldSpec[] {
  const jsonSchema = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return isNode(jsonSchema.properties) ? describeProperties(jsonSchema.properties, []) : [];
}

export const toConfigObject = (value: unknown): ConfigObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as ConfigObject) } : {};

export function getAtPath(value: ConfigObject, path: FieldPath): unknown {
  return path.reduce<unknown>((current, key) => toConfigObject(current)[key], value);
}

/** A copy of `value` with `path` set, creating intermediate objects as needed. */
export function setAtPath(value: ConfigObject, path: FieldPath, next: unknown): ConfigObject {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  return { ...value, [head]: rest.length ? setAtPath(toConfigObject(value[head]), rest, next) : next };
}

export const pathId = (path: FieldPath) => path.join('.');

/** The range a number field accepts, in words: "Whole number from 1 to 720". */
export function numberRangeText(field: Extract<FieldSpec, { kind: 'number' }>): string {
  const noun = field.integer ? 'Whole number' : 'Number';
  if (field.min !== undefined && field.max !== undefined) return `${noun} from ${field.min} to ${field.max}`;
  if (field.min !== undefined) return `${noun}, ${field.min} or more`;
  if (field.exclusiveMin !== undefined) return `${noun} above ${field.exclusiveMin}`;
  if (field.max !== undefined) return `${noun}, ${field.max} or less`;
  return noun;
}

const findField = (fields: FieldSpec[], id: string): FieldSpec | undefined => {
  for (const field of fields) {
    if (pathId(field.path) === id) return field;
    if (field.kind === 'group') {
      const nested = findField(field.fields, id);
      if (nested) return nested;
    }
  }
  return undefined;
};

/**
 * Field-level errors for `value` against the setting's schema, keyed by dotted path. A number
 * field reports its accepted range rather than Zod's wording, so every bound reads the same way.
 * An issue with no field of its own is keyed by the empty path.
 */
export function validateConfig(schema: z.ZodObject, fields: FieldSpec[], value: ConfigObject): Record<string, string> {
  const result = schema.safeParse(value);
  if (result.success) return {};
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const id = issue.path.map(String).join('.');
    if (errors[id]) continue;
    const field = findField(fields, id);
    errors[id] =
      field?.kind === 'number'
        ? `Enter a ${numberRangeText(field).toLowerCase()}.`
        : field?.kind === 'enum'
          ? `Pick one of: ${field.options.join(', ')}${field.nullable ? ', or None' : ''}.`
          : issue.message;
  }
  return errors;
}

export const formatValue = (value: unknown) =>
  value === null ? 'None' : typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value);
