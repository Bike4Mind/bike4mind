/**
 * The data-holder registry classifies every registered Mongoose model by how it holds a person's
 * data, so access/portability exports and erasure can walk one list instead of a hand-maintained
 * set of queries. `dataHolderCoverage.test.ts` fails when a model is registered but not classified,
 * so a new collection cannot silently escape an erasure.
 *
 * Paths are dotted Mongoose paths. A path inside an array of subdocuments is written through the
 * array (`users.userId`), matching how a Mongo filter addresses it.
 */

/** What erasure does with a document (or field) that references the erased person. */
export type ErasureAction =
  /** The document is the person's own data; erasure removes the whole document. */
  | { action: 'deleteDocument' }
  /**
   * The document belongs to someone else (an org, another user, the platform) but records this
   * person in it: erasure clears the reference and any listed sibling fields that repeat their
   * identity (a cached display name or email), and keeps the document.
   */
  | { action: 'anonymize'; alsoRedact?: readonly string[] }
  /**
   * The path is an array of ids or emails (`recipientUserIds`), or `<array>.<key>` into an array of
   * subdocuments (`users.userId`): erasure removes the matching elements and keeps the document.
   */
  | { action: 'pullFromArray' }
  /** The law or a legitimate interest requires keeping the reference; the reason is shown in the dry run. */
  | { action: 'retain'; reason: string };

export type UserReference = ErasureAction & {
  path: string;
  matchBy: 'userId' | 'email';
  /**
   * Extra equality filter for polymorphic references, e.g. `{ ownerType: 'User' }` when `ownerId`
   * may also hold an organization id.
   */
  where?: Readonly<Record<string, string>>;
};

export type AttributionReference = UserReference & { action: 'anonymize' };

export type DataHolder =
  /** The `User` document itself. Its own erasure runs last, after every other holder. */
  | { kind: 'subject'; secretPaths: readonly string[] }
  | {
      kind: 'holder';
      references: readonly [UserReference, ...UserReference[]];
      /** Never exported: credentials, token hashes, encrypted secrets, signed URLs. */
      secretPaths?: readonly string[];
      /** Paths whose names look like a user reference but are not one (see `looksLikeUserReference`). */
      unrelatedPaths?: readonly string[];
    }
  /**
   * The document carries no user field but belongs to a parent document that does (a file chunk
   * to its file). It follows its parent: exported with it and erased with it.
   */
  | {
      kind: 'viaParent';
      parent: string;
      /** The field on this document that holds the parent's key. */
      foreignKey: string;
      /** The parent field `foreignKey` matches; `_id` unless the parent is keyed by something else. */
      parentKey?: string;
      /**
       * People other than the parent's owner recorded on the child (a collaborator's version of
       * someone else's artifact). When the parent survives, their attribution is anonymized.
       */
      attribution?: readonly AttributionReference[];
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
