/**
 * The data-holder registry classifies every registered Mongoose model by how it holds a person's
 * data, so access/portability exports and erasure can walk one list instead of a hand-maintained
 * set of queries. `dataHolderCoverage.test.ts` fails when a model is registered but not classified,
 * so a new collection cannot silently escape an erasure.
 *
 * Paths are dotted Mongoose paths. A path inside an array of subdocuments is written through the
 * array (`users.userId`), matching how a Mongo filter addresses it.
 *
 * How one document is handled when several of its references match the person:
 * - `retain` wins: the document is never deleted, though its other references are still pulled or
 *   anonymized and the retained reference's own `alsoRedact` fields are cleared.
 * - otherwise `deleteDocument` wins and the document goes.
 * - otherwise every matching `pullFromArray` and `anonymize` applies. Inside an array of
 *   subdocuments only the matching elements change (`versions.createdBy` anonymizes the versions
 *   this person created, not every version).
 *
 * What an export includes for a document matched by each action:
 * - `deleteDocument` / `retain`: the whole document minus `secretPaths`, plus its `viaParent` children.
 * - `anonymize`: the whole document minus `secretPaths`; it records this person.
 * - `pullFromArray`: only the matching array elements and the document id. The rest of the document
 *   belongs to someone else (a notebook shared with this person) and is not this person's to take.
 */

/** What erasure does with a document (or field) that references the erased person. */
export type ErasureAction =
  /** The document is the person's own data; erasure removes the whole document. */
  | { action: 'deleteDocument' }
  /**
   * The document belongs to someone else (an org, another user, the platform) but records this
   * person in it: erasure clears the reference and any listed sibling fields that repeat their
   * identity (a cached display name, email, IP), and keeps the document.
   */
  | { action: 'anonymize'; alsoRedact?: readonly string[] }
  /**
   * The path is an array of ids or emails (`recipientUserIds`), or `<array>.<key>` into an array of
   * subdocuments (`users.userId`): erasure removes the matching elements and keeps the document.
   */
  | { action: 'pullFromArray' }
  /**
   * The law or a legitimate interest requires keeping the record; the reason is shown in the dry
   * run. `alsoRedact` lists fields the reason does not cover (marketing attribution on a billing
   * record), which erasure clears so only what the reason needs is kept.
   */
  | { action: 'retain'; reason: string; alsoRedact?: readonly string[] };

export type UserReference = ErasureAction & {
  path: string;
  matchBy: 'userId' | 'email';
  /**
   * Extra equality filter, e.g. `{ ownerType: 'User' }` when `ownerId` may also hold an
   * organization id. `null` matches a field that is absent or null, which is how an uploader's
   * personal file (`{ organizationId: null }`) is told apart from one their organization owns.
   */
  where?: Readonly<Record<string, string | null>>;
};

export type AttributionReference = UserReference & { action: 'anonymize' };

export type DataHolder =
  /** The `User` document itself. Its own erasure runs last, after every other holder. */
  | {
      kind: 'subject';
      secretPaths: readonly string[];
      /** References to the person held on OTHER users' documents (the referrer of someone they invited). */
      references: readonly AttributionReference[];
      unrelatedPaths?: readonly string[];
    }
  | {
      kind: 'holder';
      references: readonly [UserReference, ...UserReference[]];
      /** Never exported: credentials, token hashes, encrypted secrets, signed URLs. */
      secretPaths?: readonly string[];
      /** Paths whose names look like a user reference but are not one (see `looksLikeUserReference`). */
      unrelatedPaths?: readonly string[];
      /**
       * Paths that name a person in a form erasure cannot match to them (a display name cached
       * without its id, an external account handle), keyed to the reason. Listed in the dry run as
       * left in place, so the gap is visible rather than silent.
       */
      unmatchedPaths?: Readonly<Record<string, string>>;
    }
  /**
   * The document carries no user field of its own but belongs to a parent document that does (a
   * file chunk to its file). It is deleted when its parent is deleted and exported when its parent
   * is exported whole (see the export rules above). When the parent survives, the child is kept,
   * except that `attribution` is anonymized and `deleteWhenParentAnonymized` removes it.
   */
  | {
      kind: 'viaParent';
      parent: string;
      /** The field on this document that holds the parent's key. */
      foreignKey: string;
      /** The parent field `foreignKey` matches; `_id` unless the parent is keyed by something else. */
      parentKey?: string;
      /**
       * People recorded on the child who need not be the parent's owner (a collaborator's message in
       * someone else's notebook). Anonymized like a holder reference, and exported to that person.
       */
      attribution?: readonly AttributionReference[];
      /**
       * The child is the person's own content even though the parent only records them (their search
       * text under an access event that is anonymized), so it goes when the parent is anonymized.
       */
      deleteWhenParentAnonymized?: true;
      secretPaths?: readonly string[];
      unrelatedPaths?: readonly string[];
    }
  /**
   * A Mongoose discriminator: its documents live in the base model's collection and are already
   * covered by the base model's entry, so it must not be walked a second time.
   */
  | { kind: 'discriminator'; base: string }
  /**
   * Keyed by a one-way hash of an identifier rather than the identifier itself, so it cannot be
   * resolved to a person by id. Kept, and the note says why.
   */
  | { kind: 'pseudonymous'; note: string; unrelatedPaths?: readonly string[] }
  | { kind: 'noUserData'; note: string; unrelatedPaths?: readonly string[] };

export type DataHolderRegistry = Readonly<Record<string, DataHolder>>;
