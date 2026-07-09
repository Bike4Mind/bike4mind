import bcrypt from 'bcryptjs';
import { IUserDocument, IUserRepository } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

export const updateUserSchema = z.object({
  name: z.string().optional(),
  username: z.string().optional(),
  // email field removed - users must use the secure email change verification flow
  // See requestEmailChange and verifyEmailChange in userService
  password: z.string().nullable().optional(),
  team: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  preferredLanguage: z.string().nullable().optional(),
  preferredContact: z.string().nullable().optional(),
  preferredVoice: z.string().nullable().optional(),
  voiceOverrideId: z.string().nullable().optional(),
  voiceSystemPromptOverride: z.string().nullable().optional(),
  preferredReasoningEffort: z.enum(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
  tshirtSize: z.string().nullable().optional(),
  geoLocation: z.string().nullable().optional(),
  lastNotebookId: z.string().nullable().optional(),
  // `tags` is intentionally NOT in the self-service schema: user tags feed the
  // access-control layer (legacy tag gates + entitlement registry's tag->key
  // passthrough), so a non-admin updating their own profile must not be able to
  // self-grant gated products/dev bypass. Tag mutation is admin-only -
  // see `adminUpdateUserSchema` in ./adminUpdate.ts. `secureParameters` strips
  // any `tags` field a non-admin sends because it's no longer in this schema.
  lastCreditsPurchasedAt: z.date().nullable().optional(),
  systemFiles: z
    .array(
      z.object({
        fileId: z.string(),
        enabled: z.boolean(),
      })
    )
    .nullable()
    .optional(),
  securityQuestions: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .nullable()
    .optional(),
  photoUrl: z.string().nullable().optional(),
  showCreditsUsed: z.boolean().optional(),
  preferences: z
    .object({
      language: z.string().optional(),
      favoriteTags: z.array(z.string()).optional(),
      favoriteModelIds: z.array(z.string()).optional(),
      fileBrowserViewMode: z.enum(['home', 'list', 'grid', 'tags']).optional(),
      optiSessionId: z.string().nullable().optional(),
      lastUsedTextModel: z.string().nullable().optional(),
      lastUsedImageModel: z.string().nullable().optional(),
      lastUsedImageEditModel: z.string().nullable().optional(),
      showDebug: z.boolean().optional(),
      showHelp: z.boolean().optional(),
      maxVisibleLines: z.number().optional(),
      autoCollapseContent: z.boolean().optional(),
      enableAutoScroll: z.boolean().optional(),
      scrollbarWidth: z.number().optional(),
      experimentalFeatures: z.record(z.string(), z.boolean()).optional(),
      rechartsDisplayMode: z.enum(['inline', 'artifact']).optional(),
      toolsCatalogCollapsed: z.boolean().optional(),
      docxTemplateFileId: z.string().nullable().optional(),
      contextTelemetryLevel: z.enum(['none', 'basic', 'enhanced']).optional(),
      contextTelemetryConsentedAt: z.date().optional(),
      // Layer-2 Agent-mode preference. The Mongoose schema accepts it now
      // (UserModel.ts) but unknown keys never reach repo.update without being
      // listed here.
      agentModeDefault: z.enum(['off', 'auto', 'on']).optional(),
      showFunTools: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

export type UpdateUserParameters = z.infer<typeof updateUserSchema>;

export interface UpdateUserAdapters {
  db: {
    users: IUserRepository;
  };
}

export function applyBaseUserUpdates(user: IUserDocument, params: UpdateUserParameters): IUserDocument {
  // Only validate password if attempting to update it
  if (params.password !== undefined && params.password !== null) {
    if (!user.password) {
      throw new BadRequestError('User does not have a password. Cannot update password for OAuth users.');
    }
    if (bcrypt.compareSync(params.password, user.password)) {
      throw new BadRequestError('New password cannot be the same as the old password');
    }
    const hashedPassword = bcrypt.hashSync(params.password, 10);
    params.password = hashedPassword;
  }

  return {
    ...user,
    ...params,
    updatedAt: new Date(),
  };
}

export async function updateUser(userId: string, parameters: UpdateUserParameters, { db }: UpdateUserAdapters) {
  const params = secureParameters(parameters, updateUserSchema);
  const userPassword = await db.users.findByIdWithPassword(userId);

  if (!userPassword) {
    throw new Error('User not found');
  }

  const updatedUser = applyBaseUserUpdates(userPassword, params);

  await db.users.update(updatedUser);
  return updatedUser;
}
