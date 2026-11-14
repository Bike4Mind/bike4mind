import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_DESCRIPTION_MAX_LENGTH,
  ADMIN_ROLE_NAME_MAX_LENGTH,
  sortAdminPermissions,
  type AdminPermissionId,
  type AdminRole,
} from '@bike4mind/common';
import mongoose, { Model, model, Schema, Types } from 'mongoose';

/**
 * An admin role: a named set of admin permissions that users hold through `User.adminRoleIds`.
 * Validation and templates live in b4m-core/common/src/adminRoles.ts; resolution into a request's
 * effective permissions in packages/server-utils/src/auth/adminRoles.ts.
 */

type AdminRoleDocumentShape = {
  _id: Types.ObjectId;
  name: string;
  description: string;
  permissions: AdminPermissionId[];
  createdBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

const AdminRoleSchema = new Schema<AdminRoleDocumentShape>(
  {
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: ADMIN_ROLE_NAME_MAX_LENGTH },
    description: { type: String, default: '', trim: true, maxlength: ADMIN_ROLE_DESCRIPTION_MAX_LENGTH },
    permissions: {
      type: [{ type: String, enum: ADMIN_PERMISSIONS }],
      validate: { validator: (ids: string[]) => ids.length > 0, message: 'A role needs at least one permission' },
    },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: 'adminroles', timestamps: true }
);

// Case-insensitive unique names: the index is what makes a concurrent duplicate fail (11000).
// Pre-built by migration 20261114140117 rather than left to autoIndex.
export const ADMIN_ROLE_NAME_INDEX = 'adminRole_name_ci';
AdminRoleSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 }, name: ADMIN_ROLE_NAME_INDEX }
);

export const AdminRoleModel: Model<AdminRoleDocumentShape> =
  (mongoose.models.AdminRole as Model<AdminRoleDocumentShape> | undefined) ??
  model<AdminRoleDocumentShape>('AdminRole', AdminRoleSchema);

const toAdminRole = (document: AdminRoleDocumentShape): AdminRole => ({
  id: String(document._id),
  name: document.name,
  description: document.description ?? '',
  permissions: sortAdminPermissions(document.permissions ?? []),
  createdBy: document.createdBy ? String(document.createdBy) : null,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

export type AdminRoleCreateInput = Pick<AdminRole, 'name' | 'description' | 'permissions'> & { createdBy: string };
export type AdminRolePatch = Partial<Pick<AdminRole, 'name' | 'description' | 'permissions'>>;

export type IAdminRoleRepository = {
  list: () => Promise<AdminRole[]>;
  findById: (id: string) => Promise<AdminRole | null>;
  /** The roles that exist among `ids`; unknown ids are dropped, not an error. */
  findByIds: (ids: readonly string[]) => Promise<AdminRole[]>;
  /** Throws a duplicate-key error (11000) when the name is taken, ignoring case. */
  create: (input: AdminRoleCreateInput) => Promise<AdminRole>;
  /** Null when no such role. A rename onto a taken name throws 11000. */
  update: (id: string, patch: AdminRolePatch) => Promise<AdminRole | null>;
  /** False when no such role. */
  delete: (id: string) => Promise<boolean>;
};

// Ids reach here already checked as ObjectId hex by the caller, so the casts cannot throw.
class AdminRoleRepository implements IAdminRoleRepository {
  constructor(private readonly roleModel: Model<AdminRoleDocumentShape>) {}

  async list(): Promise<AdminRole[]> {
    const documents = await this.roleModel
      .find()
      .collation({ locale: 'en', strength: 2 })
      .sort({ name: 1, _id: 1 })
      .lean<AdminRoleDocumentShape[]>();
    return documents.map(toAdminRole);
  }

  async findById(id: string): Promise<AdminRole | null> {
    const document = await this.roleModel.findById(new Types.ObjectId(id)).lean<AdminRoleDocumentShape>();
    return document ? toAdminRole(document) : null;
  }

  async findByIds(ids: readonly string[]): Promise<AdminRole[]> {
    if (ids.length === 0) return [];
    const documents = await this.roleModel
      .find({ _id: { $in: ids.map(id => new Types.ObjectId(id)) } })
      .lean<AdminRoleDocumentShape[]>();
    return documents.map(toAdminRole);
  }

  async create(input: AdminRoleCreateInput): Promise<AdminRole> {
    const [document] = await this.roleModel.create([{ ...input, createdBy: new Types.ObjectId(input.createdBy) }]);
    return toAdminRole(document.toObject());
  }

  async update(id: string, patch: AdminRolePatch): Promise<AdminRole | null> {
    const document = await this.roleModel
      .findByIdAndUpdate(new Types.ObjectId(id), { $set: patch }, { new: true, runValidators: true })
      .lean<AdminRoleDocumentShape>();
    return document ? toAdminRole(document) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.roleModel.deleteOne({ _id: new Types.ObjectId(id) });
    return result.deletedCount === 1;
  }
}

export const adminRoleRepository: IAdminRoleRepository = new AdminRoleRepository(AdminRoleModel);
