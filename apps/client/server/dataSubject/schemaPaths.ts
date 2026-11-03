import type { Schema, SchemaType } from 'mongoose';

type SchemaTypeWithSubschema = SchemaType & {
  schema?: Schema;
  options: { ref?: unknown };
  /** The element type of a primitive array (`[{ type: String, ref: 'User' }]`). */
  caster?: { options?: { ref?: unknown } };
};

/** `instance` is the Mongoose type name (`String`, `Boolean`, `Array`, `Mixed`, ...). */
export type SchemaLeaf = { path: string; refsUser: boolean; instance: string };

/**
 * Every leaf path of a schema, descending into subdocuments and arrays of subdocuments, and whether
 * it is declared as a reference to the `User` model. `Schema.eachPath` stops at a subdocument
 * array, which is where shared-document access lists (`users.userId`) live, so it is not enough on
 * its own. A `Mixed` field is a single leaf: nothing below it is declared, so nothing below it is
 * listed.
 */
export function listSchemaLeaves(schema: Schema, prefix = ''): SchemaLeaf[] {
  const leaves: SchemaLeaf[] = [];
  schema.eachPath((path, schemaType: SchemaTypeWithSubschema) => {
    const fullPath = `${prefix}${path}`;
    if (schemaType.schema) {
      leaves.push(...listSchemaLeaves(schemaType.schema, `${fullPath}.`));
      return;
    }
    const ref = schemaType.options.ref ?? schemaType.caster?.options?.ref;
    leaves.push({ path: fullPath, refsUser: ref === 'User', instance: schemaType.instance });
  });
  return leaves;
}

export function listSchemaPaths(schema: Schema): string[] {
  return listSchemaLeaves(schema).map(leaf => leaf.path);
}

/**
 * Whether `dottedPath` names a field the schema declares. A path under a `Mixed` field is accepted,
 * because Mongoose has no declaration below it to check against.
 */
export function schemaDeclaresPath(schema: Schema, dottedPath: string): boolean {
  if (schema.path(dottedPath)) return true;

  const segments = dottedPath.split('.');
  for (let split = segments.length - 1; split > 0; split--) {
    const head = schema.path(segments.slice(0, split).join('.')) as SchemaTypeWithSubschema | undefined;
    if (!head) continue;
    if (head.instance === 'Mixed') return true;
    if (head.schema) return schemaDeclaresPath(head.schema, segments.slice(split).join('.'));
    return false;
  }
  return false;
}

// Matched against a path segment with underscores removed, so `created_by` reads as `createdby`.
// A role noun, optionally plural, with an optional id suffix (`ownerId`, `actorUserId`, `memberIds`,
// `sharedWithUsers`); a `...by` attribution (`createdBy`, `usedby`); a permission list (`canWrite`);
// a share list (`sharedWith`); an email or contact address. Deliberately broad: a false positive
// costs one `unrelatedPaths` entry, while a miss is an erasure that leaves personal data behind.
const ROLE_NOUN =
  '(user|owner|actor|principal|author|creator|reporter|reviewer|requester|recipient|receiver|sender|inviter|invitee|grantee|viewer|assignee|payer|member|participant|editor|subscriber)';
const ROLE_REFERENCE = new RegExp(`${ROLE_NOUN}s?(user)?(ids?|names?)?$`, 'i');
const ROLE_PARENT = new RegExp(`${ROLE_NOUN}s?$`, 'i');
const SEGMENT_PATTERNS = [
  ROLE_REFERENCE,
  // `admin` alone is usually a flag (`isAdmin`); only its id form names a person.
  /admin(user)?ids?$/i,
  /by(id|userid)?$/i,
  /^can(read|write|delete|edit|view|access|manage)/i,
  /^shared/i,
  /email/i,
  /contact$/i,
  /^uid$/i,
];

export function looksLikeUserReference(path: string): boolean {
  const segments = path.split('.');
  const leaf = segments[segments.length - 1];
  if (SEGMENT_PATTERNS.some(pattern => pattern.test(leaf.replace(/_/g, '')))) return true;
  // `author.id`, `editor.id`: the role is named by the parent, not the leaf. A subdocument's own
  // `_id` is not this case.
  const parent = segments[segments.length - 2];
  return leaf === 'id' && parent !== undefined && ROLE_PARENT.test(parent);
}

// A credential, token, one-time code or its hash, matched against the leaf with underscores removed.
// Content and file hashes (`contentHash`) and token counters (`maxTokens`) are deliberately not matched.
const SECRET_PATTERNS = [
  /(token|secret|password|passphrase|privatekey|pvk|nonce|otc)$/i,
  /(token|secret|code|key|password|passphrase|otc|nonce)hash(es)?$/i,
  /^(sid|code|ticket|challenge|apikey|presignedurl|signedurl|downloadurl|backupcodes)$/i,
];
// A flag (`hasAccessToken`), counter or timestamp names a secret without holding one.
const NON_SECRET_INSTANCES = new Set(['Boolean', 'Number', 'Date']);

export function looksLikeSecret(leaf: SchemaLeaf): boolean {
  if (NON_SECRET_INSTANCES.has(leaf.instance)) return false;
  const segments = leaf.path.split('.');
  // `error.code`, `lastError.code`: a provider's error code, not a one-time code.
  if (segments.length > 1 && /error$/i.test(segments[segments.length - 2])) return false;
  const name = segments[segments.length - 1].replace(/_/g, '');
  return SECRET_PATTERNS.some(pattern => pattern.test(name));
}
