import { describe, it, expect } from 'vitest';
import { Schema } from 'mongoose';
import { z } from 'zod';
import { PromptMetaZodSchema } from '@bike4mind/common';
import { PromptMetaSchema } from '../QuestModel';

/**
 * PromptMetaZodSchema is the source of truth for promptMeta; PromptMetaSchema is what actually
 * persists it. Mongoose runs strict, so any path declared in one and missing from the other is
 * dropped in silence - on save() and on the findOneAndUpdate + $set path production uses.
 *
 * This is the guard that turns that silence into a failing build. Adding a Zod field without the
 * Mongoose declaration fails here, and so does the reverse.
 *
 * Scope: path names only. A path declared with a mismatched BSON type, or optional here against a
 * required Zod field, still passes. QuestModel.promptMetaPersistence.test.ts covers the type half
 * for anything in its fixture by parsing the stored document back through the Zod schema.
 */

/**
 * Paths deliberately allowed to be dropped. These carry prompt and conversation CONTENT, and the
 * quest document is serialized to the client on many read paths, so persisting them would leak a
 * server-owned prompt. See the extraContextMessages write site in ChatCompletionProcess.
 *
 * Adding to this list is a security decision, not a shortcut around a failing test.
 */
const INTENTIONALLY_NOT_PERSISTED: Record<string, string> = {
  'context.systemPrompt': 'assembled system prompt text',
  'context.userPrompt': 'raw user prompt text, already stored as promptMeta.prompt',
  'context.conversationContext.role': 'duplicates the whole conversation onto every turn',
  'context.conversationContext.content': 'duplicates the whole conversation onto every turn',
  'context.conversationContext.timestamp': 'duplicates the whole conversation onto every turn',
  'context.extraContextMessages.role': 'carries a server-owned prompt for some product surfaces',
  'context.extraContextMessages.content': 'carries a server-owned prompt for some product surfaces',
  'context.extraContextMessages.fabFileIds': 'carries a server-owned prompt for some product surfaces',
  'context.systemPromptSources.content': 'system prompt text; readers of this array use source, fileName and length',
  'context.systemPromptDisclosure.blocks.text':
    'disclosed prompt text; returned inline to the caller that asked for it, never stored',
};

/**
 * Dotted leaf paths of a JSON Schema. Arrays contribute no path segment, so `artifacts[].content`
 * is `artifacts.content` - matching how Mongoose names document-array subpaths.
 */
function jsonSchemaLeafPaths(node: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return out;
  const schema = node as Record<string, unknown>;

  // A union contributes every branch's paths at the same position.
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) jsonSchemaLeafPaths(branch, prefix, out);
    return out;
  }
  if (schema.items) return jsonSchemaLeafPaths(schema.items, prefix, out);

  const properties = schema.properties as Record<string, unknown> | undefined;
  if (properties && Object.keys(properties).length > 0) {
    for (const [key, child] of Object.entries(properties)) {
      jsonSchemaLeafPaths(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }

  // Leaf: a scalar, an open record (additionalProperties with no properties), or an
  // unrepresentable type such as z.date(), which toJSONSchema renders as {}.
  if (prefix) out.add(prefix);
  return out;
}

type MongooseLeaves = { leaves: Set<string>; absorbing: Set<string> };

/**
 * Dotted leaf paths of a Mongoose schema, plus the subset that absorb everything beneath them.
 * Mixed and Map accept arbitrary nested content, which is how contextTelemetry and
 * functionCalls.parameters stay legal without enumerating every subpath.
 */
function mongooseLeafPaths(schema: Schema, prefix = '', acc?: MongooseLeaves): MongooseLeaves {
  const out = acc ?? { leaves: new Set<string>(), absorbing: new Set<string>() };

  for (const [name, path] of Object.entries(schema.paths)) {
    if (name === '_id' || name === '__v' || name.endsWith('$*')) continue;
    const full = prefix ? `${prefix}.${name}` : name;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = path as any; // any: Mongoose does not export the SchemaType discriminant flags.
    if (p.$isMongooseDocumentArray || p.$isSingleNested) {
      mongooseLeafPaths(p.schema, full, out);
      continue;
    }
    if (p.instance === 'Mixed' || p.$isSchemaMap) {
      out.absorbing.add(full);
    }
    out.leaves.add(full);
  }

  return out;
}

const zodLeaves = jsonSchemaLeafPaths(z.toJSONSchema(PromptMetaZodSchema, { unrepresentable: 'any', io: 'input' }));
const { leaves: mongoLeaves, absorbing } = mongooseLeafPaths(PromptMetaSchema);

const isAbsorbed = (path: string) => [...absorbing].some(a => path.startsWith(`${a}.`));

describe('PromptMetaSchema / PromptMetaZodSchema parity', () => {
  it('enumerates both schemas, so an empty comparison cannot pass vacuously', () => {
    expect(zodLeaves.size).toBeGreaterThan(200);
    expect(mongoLeaves.size).toBeGreaterThan(100);
  });

  it('declares every Zod path that is not deliberately dropped', () => {
    const undeclared = [...zodLeaves]
      .filter(path => !mongoLeaves.has(path) && !isAbsorbed(path))
      .filter(path => !(path in INTENTIONALLY_NOT_PERSISTED))
      .sort();

    expect(undeclared).toEqual([]);
  });

  it('declares nothing the Zod schema does not describe', () => {
    // A Mongoose-only path is drift in the other direction: it persists, but the API type and
    // the ingress parse in ChatCompletionInvoke do not know about it. Also catches a typo in a
    // new declaration, which would otherwise look like a legitimately extra field.
    //
    // A Mixed or Map path stands in for a whole Zod subtree (contextTelemetry, citables.metadata),
    // so it counts as described when Zod has anything underneath it - the parent object node
    // itself is never emitted as a leaf.
    const describedByZod = (path: string) =>
      zodLeaves.has(path) ||
      isAbsorbed(path) ||
      (absorbing.has(path) && [...zodLeaves].some(leaf => leaf.startsWith(`${path}.`)));

    const unknownToZod = [...mongoLeaves].filter(path => !describedByZod(path)).sort();

    expect(unknownToZod).toEqual([]);
  });

  it('keeps every excluded path genuinely undeclared', () => {
    // Guards the list itself: declaring one of these later must not leave a stale entry behind
    // claiming it is still dropped.
    const declaredAnyway = Object.keys(INTENTIONALLY_NOT_PERSISTED).filter(path => mongoLeaves.has(path));

    expect(declaredAnyway).toEqual([]);
  });

  it('only excludes paths the Zod schema still has', () => {
    const stale = Object.keys(INTENTIONALLY_NOT_PERSISTED).filter(path => !zodLeaves.has(path));

    expect(stale).toEqual([]);
  });
});
