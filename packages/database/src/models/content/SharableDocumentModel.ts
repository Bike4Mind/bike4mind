import mongoose, { Schema } from 'mongoose';
import {
  IGroupShare,
  IShareableStaticMethods,
  IUserDocument,
  IUserShare,
  Permission,
  UserShareGrant,
  UserShareMatch,
  UserSharesChange,
} from '@bike4mind/common';
import { usableObjectIds } from '../../utils/mongo';

export const GroupShareableSchema: Schema<IGroupShare> = new Schema<IGroupShare>({
  groupId: { type: String, required: true },
  permissions: {
    type: [String],
    enum: Object.keys(Permission),
    required: true,
  },
});

export const UserShareableSchema: Schema<IUserShare> = new Schema<IUserShare>(
  {
    userId: { type: String, required: true },
    permissions: {
      type: [String],
      enum: Object.keys(Permission),
      required: true,
    },
    projectId: { type: String, required: false },
    sessionId: { type: String, required: false },

    extraData: {
      type: Map,
      of: Schema.Types.Mixed,
    },
  },
  {
    _id: false,
    id: false,
    versionKey: false,
  }
);

UserShareableSchema.virtual('user', {
  ref: 'User',
  localField: 'userId',
  foreignField: '_id',
  justOne: true,
});

// Basic stub for sharing files and tools.
export const ShareableDocumentSchema: {
  isGlobalRead: { type: BooleanConstructor; default: boolean };
  isGlobalWrite: { type: BooleanConstructor; default: boolean };
  groups: { type: Schema<IGroupShare>[]; default: never[] };
  users: { type: Schema<IUserShare>[]; default: never[] };
} = {
  isGlobalRead: { type: Boolean, default: false },
  isGlobalWrite: { type: Boolean, default: false },
  groups: {
    type: [GroupShareableSchema],
    default: [],
  },
  users: {
    type: [UserShareableSchema],
    default: [],
  },
};

/**
 * The `$or` arms granting update access: owner, users[].update, groups[].update. Shared by the
 * update-access finders below and the write-time re-check in SessionRepository.updateWithUpdateAccess,
 * so the read that authorizes a write and the write itself cannot drift apart.
 */
export const updateAccessArms = (
  user: Pick<IUserDocument, 'id' | 'groups'>,
  opts?: { includeGlobalWrite?: boolean }
): Record<string, unknown>[] => [
  { userId: user.id },
  { users: { $elemMatch: { userId: user.id, permissions: { $in: ['update'] } } } },
  { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['update'] } } } },
  // Opt-in: a global-write share grants update access (mirrors the CASL rule
  // allow(update, resource, { isGlobalWrite: true })). Off by default so sharing-mutation
  // callers keep the strict owner/user-update/group-update arms - a global-write sharee must
  // not gain share or delete, only write.
  ...(opts?.includeGlobalWrite ? [{ isGlobalWrite: true }] : []),
];

/**
 * The `$or` arms granting read access: owner, users[] read|write, groups[] read|write. Deliberately
 * no `isGlobalRead` arm. Shared by findAccessibleById/findAllAccessibleByIds and the public project
 * list (ProjectRepository.listAccessibleAfterId), so every id that list returns is one the by-id
 * read also resolves.
 */
export const readAccessArms = (user: Pick<IUserDocument, 'id' | 'groups'>): Record<string, unknown>[] => [
  { userId: user.id },
  { users: { $elemMatch: { userId: user.id, permissions: { $in: ['read', 'write'] } } } },
  { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['read', 'write'] } } } },
];

// Pipeline updates skip Mongoose casting, so values go in as `$literal` and stored ids compare via
// `$toString` (a legacy ObjectId userId or projectId still matches).
const sameTag = (path: string, value: string | undefined) => ({
  $eq: [{ $toString: { $ifNull: [path, null] } }, { $literal: value ?? null }],
});

// Scratch field holding `users` as read, so the final stage can skip the version bump on a no-op.
const USERS_BEFORE = '__usersBefore';

const rowMatches = (match: UserShareMatch) => ({
  $and: [
    ...(match.userId !== undefined ? [{ $eq: [{ $toString: '$$row.userId' }, { $literal: match.userId }] }] : []),
    ...(match.projectId !== undefined ? [sameTag('$$row.projectId', match.projectId)] : []),
  ],
});

/** Pipeline twin of sharingService's pushShareable; keep the merge key and union rule in sync with it. */
const mergeGrantStage = (grant: UserShareGrant) => {
  const sameRow = {
    $and: [
      { $eq: [{ $toString: '$$row.userId' }, { $literal: grant.userId }] },
      sameTag('$$row.projectId', grant.projectId),
      sameTag('$$row.sessionId', grant.sessionId),
    ],
  };
  const unionPermissions = {
    $reduce: {
      input: { $concatArrays: [{ $ifNull: ['$$row.permissions', []] }, { $literal: grant.permissions }] },
      initialValue: [],
      in: { $cond: [{ $in: ['$$this', '$$value'] }, '$$value', { $concatArrays: ['$$value', ['$$this']] }] },
    },
  };
  const newRow = {
    userId: grant.userId,
    permissions: grant.permissions,
    ...(grant.projectId !== undefined ? { projectId: grant.projectId } : {}),
    ...(grant.sessionId !== undefined ? { sessionId: grant.sessionId } : {}),
  };
  return {
    $set: {
      users: {
        $let: {
          vars: { rows: { $ifNull: ['$users', []] } },
          in: {
            $cond: [
              { $anyElementTrue: [{ $map: { input: '$$rows', as: 'row', in: sameRow } }] },
              {
                $map: {
                  input: '$$rows',
                  as: 'row',
                  in: {
                    $cond: [
                      sameRow,
                      {
                        $mergeObjects: ['$$row', { userId: { $literal: grant.userId }, permissions: unionPermissions }],
                      },
                      '$$row',
                    ],
                  },
                },
              },
              { $concatArrays: ['$$rows', [{ $literal: newRow }]] },
            ],
          },
        },
      },
    },
  };
};

export class ShareableDocumentRepository<T> implements IShareableStaticMethods<T> {
  private model: mongoose.Model<T>;

  constructor(model: mongoose.Model<T>) {
    this.model = model;
  }

  async findAllAccessible(user: IUserDocument): Promise<T[]> {
    return this.model.find({
      $or: [
        { userId: user.id },
        { users: { $elemMatch: { userId: user.id, permissions: { $in: ['read', 'write'] } } } },
        { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['read', 'write'] } } } },
      ],
    });
  }

  async findAllShared(user: IUserDocument): Promise<T[]> {
    return this.model.find({
      $or: [
        { users: { $elemMatch: { userId: user.id, permissions: { $in: ['read', 'write'] } } } },
        { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['read', 'write'] } } } },
      ],
    });
  }

  /**
   * Ids reach here from `session.knowledgeIds` and `project.fileIds`/`sessionIds`, all declared
   * `[{ type: String }]` - see usableObjectIds. Guarded here rather than in the nine callers
   * (projectService add/remove files|sessions|systemPrompts, fabFileService list|toggleTags,
   * sessionService update), since /api/files/byIds turns the CastError into a 404 on the
   * notebook file list. Every `shareable` repository shares this method - Session, FabFile,
   * Project, Agent, Skill, Tool, Organization - and all of them are ObjectId-keyed.
   */
  async findAllAccessibleByIds(
    user: Pick<IUserDocument, 'id' | 'groups'>,
    ids: string[],
    options?: { includeDeleted?: boolean }
  ): Promise<T[]> {
    const query = this.model.where({
      _id: { $in: usableObjectIds(ids, `${this.model.modelName}.findAllAccessibleByIds`) },
      $or: readAccessArms(user),
    });
    return options?.includeDeleted ? query.setOptions({ includeDeleted: true }) : query;
  }

  /**
   * Single-id counterpart to findAllAccessibleByIds. The `$in` guard there drops an id that
   * cannot address a row; here there is only one, so an uncastable id means no such row -
   * reported as `null` rather than as a CastError the calling route cannot attribute. Same
   * contract, and same reasoning, as `BaseRepository.findById` in db-core.
   */
  async findAccessibleById(user: Pick<IUserDocument, 'id' | 'groups'>, id: string): Promise<T | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const doc = await this.model.findOne({
      _id: id,
      $or: readAccessArms(user),
    });

    // `?? null` so both misses report the same value: `doc?.toJSON()` yields undefined, which the
    // `as T | null` cast hid from a caller narrowing with `!== null`.
    return (doc?.toJSON() ?? null) as T | null;
  }

  /** Same id guard as findAccessibleById. */
  async findUpdateAccessById(
    user: Pick<IUserDocument, 'id' | 'groups'>,
    id: string,
    opts?: { includeGlobalWrite?: boolean }
  ): Promise<T | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    return this.model.findOne({
      _id: { $in: id },
      $or: updateAccessArms(user, opts),
    });
  }

  /** Batch counterpart to findUpdateAccessById; same id guard as findAllAccessibleByIds. */
  async findAllUpdateAccessByIds(user: Pick<IUserDocument, 'id' | 'groups'>, ids: string[]): Promise<T[]> {
    return this.model.where({
      _id: { $in: usableObjectIds(ids, `${this.model.modelName}.findAllUpdateAccessByIds`) },
      $or: updateAccessArms(user),
    });
  }

  /** Same id guard as findAccessibleById. */
  async findShareAccessById(user: Pick<IUserDocument, 'id' | 'groups'>, id: string): Promise<T | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    return this.model.findOne({
      _id: id,
      // Own / users-share / groups-share, mirroring the CASL `Permission.share` arms
      // in ability.ts (own, users[].share, groups[].share) and matching the sibling
      // findAccessById / findUpdateAccessById statics, which both include the groups arm.
      $or: [
        { userId: user.id },
        { users: { $elemMatch: { userId: user.id, permissions: { $in: ['share'] } } } },
        { groups: { $elemMatch: { groupId: { $in: user.groups }, permissions: { $in: ['share'] } } } },
      ],
    });
  }

  async updateUserShares(id: string, changes: UserSharesChange): Promise<T | null> {
    if (!mongoose.isObjectIdOrHexString(id)) return null;
    const { remove, add = [] } = changes;
    if (remove && remove.userId === undefined && remove.projectId === undefined) {
      throw new Error('updateUserShares: remove needs a userId or projectId');
    }

    const stages: Record<string, unknown>[] = [];
    if (remove) {
      stages.push({
        $set: {
          users: {
            $filter: { input: { $ifNull: ['$users', []] }, as: 'row', cond: { $not: [rowMatches(remove)] } },
          },
        },
      });
    }
    for (const grant of add) {
      stages.push(mergeGrantStage({ ...grant, permissions: Array.from(new Set(grant.permissions)) }));
    }
    if (stages.length === 0) return ((await this.model.findById(id))?.toJSON() ?? null) as T | null;

    // The version is bumped only when `users` changed: a no-op (e.g. removing a project that has no
    // rows here) must not make a concurrent version-guarded write of `users` fail with a spurious
    // conflict. `updatedAt` still moves, since Mongoose's timestamps hook stamps it on every update.
    const versionKey = this.model.schema.get('versionKey');
    const changed = { $ne: ['$users', `$${USERS_BEFORE}`] };
    stages.unshift({ $set: { [USERS_BEFORE]: { $ifNull: ['$users', []] } } });
    stages.push(
      {
        $set: {
          ...(this.model.schema.get('timestamps') ? { updatedAt: '$$NOW' } : {}),
          ...(typeof versionKey === 'string'
            ? {
                [versionKey]: {
                  $cond: [changed, { $add: [{ $ifNull: [`$${versionKey}`, 0] }, 1] }, `$${versionKey}`],
                },
              }
            : {}),
        },
      },
      { $unset: USERS_BEFORE }
    );

    const doc = await this.model.findOneAndUpdate({ _id: id }, stages as mongoose.UpdateWithAggregationPipeline, {
      new: true,
    });
    return (doc?.toJSON() ?? null) as T | null;
  }
}

export type { IShareableDocument, IGroupShare } from '@bike4mind/common';
