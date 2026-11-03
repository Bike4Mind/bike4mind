import type { Schema, SchemaType } from 'mongoose';

type SchemaTypeWithSubschema = SchemaType & { schema?: Schema };

/**
 * Every leaf path of a schema, descending into subdocuments and arrays of subdocuments.
 * `Schema.eachPath` stops at a subdocument array, which is where shared-document access lists
 * (`users.userId`) live, so it is not enough on its own.
 */
export function listSchemaPaths(schema: Schema, prefix = ''): string[] {
  const paths: string[] = [];
  schema.eachPath((path, schemaType: SchemaTypeWithSubschema) => {
    const fullPath = `${prefix}${path}`;
    if (schemaType.schema) {
      paths.push(...listSchemaPaths(schemaType.schema, `${fullPath}.`));
      return;
    }
    paths.push(fullPath);
  });
  return paths;
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

// The last segment of a path that holds a person: a role noun with an optional id suffix
// (`ownerId`, `actorUserId`, `reviewerId`), a `...By` attribution (`createdBy`, `revokedBy`), or an
// email address. Deliberately broad: a false positive costs one `unrelatedPaths` entry, while a miss
// is an erasure that leaves personal data behind.
const ROLE_REFERENCE =
  /(user|owner|actor|principal|author|creator|reporter|reviewer|requester|recipient|sender|inviter|viewer|assignee|payer)(ids?)?$/i;
const ATTRIBUTION = /By(Id|UserId)?$/;
const EMAIL = /email/i;

export function looksLikeUserReference(path: string): boolean {
  const leaf = path.split('.').pop() ?? path;
  return ROLE_REFERENCE.test(leaf) || ATTRIBUTION.test(leaf) || EMAIL.test(leaf);
}
