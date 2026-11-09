/**
 * The data-holder registry classifies every registered Mongoose model by how it holds a person's
 * data, so access/portability exports and erasure can walk one list instead of a hand-maintained
 * set of queries. `dataHolderCoverage.test.ts` fails when a model is registered but not classified.
 * It sees only the models registered by `@bike4mind/database` and the modules it imports itself, so a
 * model registered anywhere else escapes it until that test imports the module that registers it.
 *
 * Paths are dotted Mongoose paths. A path inside an array of subdocuments is written through the
 * array (`users.userId`), matching how a Mongo filter addresses it.
 *
 * `dataHolderCoverage.test.ts` cannot see below a `Mixed` field (`metadata`, `payload`), because the
 * schema declares nothing there. A person or secret stored under one is classified by hand, as
 * `CreditTransaction` does with `metadata.actorId`.
 *
 * How one document is handled when several of its references match the person:
 * - `retain` wins: the document is never deleted, though its other references are still pulled or
 *   anonymized and the retained reference's own `alsoRedact` fields are cleared.
 * - otherwise `deleteDocument` wins and the document goes.
 * - otherwise every matching `pullFromArray` and `anonymize` applies. Inside an array of
 *   subdocuments only the matching elements change (`versions.createdBy` anonymizes the versions
 *   this person created, not every version).
 *
 * Content shared with others:
 * - What the person owns goes, even when others can see it (their notebook shared with a team, their
 *   personal lake), and the access entries inside it go with it.
 * - What the person wrote inside something another user or an organization owns (a message in
 *   someone else's notebook, an upload to an org's lake, a version of a shared artifact) stays with
 *   that owner, anonymized: the reference becomes the "Deleted user" placeholder, so the owner's
 *   record stays whole. The text itself is not rewritten.
 * - The exception is an annotation thread: it is the author's own comment rather than part of the
 *   owner's content, so `Annotation` deletes it with its author wherever it sits.
 * - The person's own access to others' content (`sharedWith`, a membership) is pulled.
 *
 * What an export includes for a document (`exportScope.ts` implements this):
 * - A `deleteDocument` or `retain` match on a scalar path (`userId`, `metadata.actorId`) marks the
 *   document as the person's own record: the whole document minus `secretPaths`, plus its
 *   `viaParent` children. A `retain` with `exportScope: 'reference'` is the exception: the person is
 *   only the actor on a record about someone else.
 * - Any other match exports only the matched paths and the document id. That is every `anonymize`
 *   (the document belongs to someone else and only records this person: a referrer's export carries
 *   the `referredByUserId` of each account they referred, not those accounts), with its `alsoRedact`
 *   fields because they repeat this person's identity; every `exportScope: 'reference'` match, with
 *   its `identifies` fields for the same reason; and every match through an array (an array of
 *   ids such as `userIds`, or a key inside an array of subdocuments such as `versions.createdBy`),
 *   whatever the action, where only the matching elements are exported. The other elements name
 *   other people (co-members of a fraud cluster, other editors of a page).
 * When a document matches several references and one of them is an own-record match, the whole
 * document is exported, less every other person on it: a reference that names someone else goes
 * with its `alsoRedact` and `identifies` fields, and an array a reference reads through keeps only
 * this person's elements.
 */

/** What erasure does with a document (or field) that references the erased person. */
export type ErasureAction =
  /** The document is the person's own data; erasure removes the whole document. */
  | { action: 'deleteDocument' }
  /**
   * The document belongs to someone else (an org, another user, the platform) but records this
   * person in it: erasure clears the reference and any listed sibling fields that repeat their
   * identity (a cached display name, email, IP), and keeps the document. Many targets are
   * `required` (`FabFile.userId`, `Artifact.userId`), so the executor overwrites them with a fixed
   * placeholder rather than unsetting them, or the document would fail validation on its next save.
   */
  | { action: 'anonymize'; alsoRedact?: readonly string[] }
  /**
   * The path is an array of ids or emails (`recipientUserIds`), or `<array>.<key>` into an array of
   * subdocuments (`users.userId`): erasure removes the matching elements and keeps the document.
   */
  | { action: 'pullFromArray' }
  /**
   * The law or a legitimate interest requires keeping the record; the reason and how long it is kept
   * are shown in the dry run. `alsoRedact` lists fields the reason does not cover (marketing
   * attribution on a billing record), which erasure clears so only what the reason needs is kept.
   */
  | { action: 'retain'; reason: string; retention: RetentionPeriod; alsoRedact?: readonly string[] };

/**
 * How long a retained record outlives the erasure request. `registry/retention.ts` holds the shared
 * periods, so a policy change is one edit.
 */
export type RetentionPeriod =
  /**
   * A TTL index on `field` deletes the record `days` after that date. `dataHolderCoverage.test.ts`
   * checks the model declares exactly this index, and that a retained model with any TTL index says so.
   */
  | { expiresBy: 'ttlIndex'; field: string; days: number }
  /**
   * A policy period counted from `from`. Nothing deletes these records on a timer yet, so erasure
   * lists them with the period rather than claiming they expire.
   */
  | { expiresBy: 'policy'; years: number; from: string }
  /** Kept while a condition holds rather than for a fixed time (a suppression entry, while the objection stands). */
  | { expiresBy: 'condition'; until: string };

export type UserReference = ErasureAction & {
  path: string;
  /**
   * `email` is compared case-insensitively with the user's current email only: User does not
   * lowercase on write and keeps no previous addresses, so a later change of address is not matched.
   */
  matchBy: 'userId' | 'email';
  /** Extra equality filter, e.g. `{ ownerType: 'User' }` when `ownerId` may also hold an organization id. */
  where?: Readonly<Record<string, string>>;
  /**
   * `personal` limits the reference to the person's own content, not their organization's. It is not
   * a literal filter: personal rows store `organizationId` as null, absent or `''`, or name one of
   * the person's personal-workspace organizations, so the executor must reuse the account purge's
   * predicate (`personalFilter` in `server/users/purgeAccountContent.ts`; for `FabFile` also
   * `isOrganizationFile` in `packages/server-utils/src/users/purgeAccountFiles.ts`, which keeps legacy org uploads).
   */
  scope?: 'personal';
  /**
   * Fields beside `path` that describe the person it names (a cached name, email, request IP), for
   * a reference that does not clear them on erasure (a `retain`). They travel with this person's
   * matched paths and are withheld from anyone else's export of the document. Erasure does not read
   * this; it clears `alsoRedact`.
   */
  identifies?: readonly string[];
  /**
   * `reference` marks a `retain` whose person is only the actor on a record about someone else (the
   * admin who wrote a note or an audit entry): their export carries the matched paths, not the
   * record, as for an `anonymize`.
   */
  exportScope?: 'reference';
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
      /** Never exported: credentials, token hashes, encrypted secrets, signed URLs, server-only diagnostics. */
      secretPaths?: readonly string[];
      /** Exported functions the erasure executor must call before walking this holder's references. */
      beforeErasure?: readonly string[];
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
   * file chunk to its file). It is deleted when its parent is deleted. When the parent survives, the
   * child is kept, except that `attribution` is anonymized and `deleteWhenParentAnonymized` removes it.
   * It is exported whole when its parent is exported whole (an own-record match, per the export rules
   * above) or when `deleteWhenParentAnonymized` marks it as the person's own content. Otherwise a
   * parent match alone exports nothing from it: only a match on its own `attribution` does, and then
   * only the matched paths.
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
       * someone else's notebook). Anonymized like a holder reference; that person's export carries only
       * the matched paths and the child's id.
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
