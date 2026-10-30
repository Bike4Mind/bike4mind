import bcrypt from 'bcryptjs';
import {
  ConflictError,
  IAdminSettingsRepository,
  IUserDocument,
  IUserPreferences,
  IUserRepository,
  USERNAME_RULES_MESSAGE,
  usernameSchema,
} from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { isDuplicateKeyErrorOn } from './duplicateKeyError';
import { assertUsernameNotReserved } from './reservedUsername';

export const USERNAME_TAKEN_MESSAGE = 'That username is taken.';
export const EMAIL_IN_USE_MESSAGE = 'That email address is already in use.';

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
  //
  // `lastCreditsPurchasedAt` is intentionally NOT here either: it is server-owned
  // metadata stamped only by a net credit grant (see `adminUpdateUser`'s `builtParams`
  // and `addCredits`'s `type === 'purchase'` stamp). Accepting it here would let any
  // caller (admin or self-service) clear or forge the timestamp via a plain PUT.
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
    .array(z.object({ question: z.string().max(512), answer: z.string().max(1024) }))
    .max(10)
    .nullable()
    .optional(),
  // `photoUrl` is intentionally NOT in the self-service schema (same reasoning as
  // `tags` above): it is an S3 key that apps/client/pages/api/users/[id]/confirm-photo.ts
  // writes and later dereferences for DELETION (storage.delete + AppFile removal). A self-set
  // value would let a caller point it at a resource they do not own, turning their next photo
  // upload into an arbitrary-file delete. The dedicated confirm-photo endpoint is the only
  // writer; secureParameters strips any `photoUrl` a caller sends here.
  showCreditsUsed: z.boolean().optional(),
  preferences: z
    .object({
      language: z.string().optional(),
      favoriteTags: z.array(z.string()).optional(),
      favoriteModelIds: z.array(z.string()).optional(),
      hiddenSurfaces: z.array(z.string().max(64)).max(32).optional(),
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
      // `docxTemplateFileId` is intentionally NOT here (same reasoning as `photoUrl`/`tags`):
      // it is an AppFile id that docx-template.ts later dereferences (read + tag mutation).
      // The dedicated docx-template POST endpoint validates ownership before setting it; a
      // self-service write could point it at a foreign file. secureParameters strips it here.
      contextTelemetryLevel: z.enum(['none', 'basic', 'enhanced']).optional(),
      // coerce: the settings UI echoes this back as an ISO string from GET /users/{id},
      // so a strict z.date() 422s on every write after the first (which mints a real Date).
      contextTelemetryConsentedAt: z.coerce.date().optional(),
      // Layer-2 Agent-mode preference. The Mongoose schema accepts it now
      // (UserModel.ts) but unknown keys never reach repo.update without being
      // listed here.
      agentModeDefault: z.enum(['off', 'auto', 'on']).optional(),
      showFunTools: z.boolean().optional(),
      showSplashCards: z.boolean().optional(),
      desktopPromoDismissed: z.boolean().optional(),
      promptCacheTtl: z.enum(['5m', '1h']).optional(),
    })
    .nullable()
    .optional(),
});

export type UpdateUserParameters = z.infer<typeof updateUserSchema>;

export interface UpdateUserAdapters {
  db: {
    users: IUserRepository;
    // Reads the synthetic test domains that let a verified test account keep a reserved username.
    // Absent: no reserved username is allowed.
    adminSettings?: Pick<IAdminSettingsRepository, 'findBySettingName'>;
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

  if (params.securityQuestions) {
    const stored = user.securityQuestions ?? [];
    // Each stored answer is claimed at most once. Matching on text alone collapses two stored
    // answers to the same question onto the first one, silently dropping the second.
    const claimed = new Set<number>();

    // An answered entry keeps the slot it occupies, so a blank submitted at the same position
    // cannot fall back onto an answer the user just replaced.
    params.securityQuestions.forEach((question, i) => {
      if (question.answer && stored[i]?.question === question.question) claimed.add(i);
    });

    params.securityQuestions = params.securityQuestions.map((question, i) => {
      if (question.answer) return question;
      const sameIndex = stored[i]?.question === question.question && !claimed.has(i) ? i : -1;
      const index =
        sameIndex >= 0
          ? sameIndex
          : stored.findIndex((entry, j) => !claimed.has(j) && entry.question === question.question);
      if (index < 0) {
        throw new BadRequestError('An answer is required for a new or renamed security question');
      }
      const existing = stored[index];
      if (!existing.answer) {
        throw new BadRequestError('An answer is required for a new or renamed security question');
      }
      claimed.add(index);
      return { ...question, answer: existing.answer };
    });
  }

  return {
    ...user,
    ...params,
    ...(params.preferences && { preferences: mergePreferences(user.preferences, params.preferences) }),
    updatedAt: new Date(),
  };
}

/**
 * Reduce a fully-built user document to the targeted write partial: the id, a fresh
 * updatedAt, and ONLY the fields the request actually changed. Persisting this instead
 * of the whole built document is what stops a profile or admin save from round-tripping
 * (and thereby reverting a concurrent write to) currentCredits, tokenVersion, isBanned,
 * tags and every other field the caller never sent. `params` supplies the changed-field
 * keys; `built` supplies their post-merge values (hashed password, merged preferences).
 */
export function toUserUpdatePartial(
  built: IUserDocument,
  params: Record<string, unknown>
): Partial<IUserDocument> & { id: string } {
  const write: Record<string, unknown> = { id: built.id, updatedAt: built.updatedAt };
  for (const key of Object.keys(params)) {
    if (key === 'id') continue;
    write[key] = (built as unknown as Record<string, unknown>)[key];
  }
  return write as Partial<IUserDocument> & { id: string };
}

/**
 * `preferences` is merged onto the stored object, not replaced, so a partial write cannot
 * silently drop keys the caller omitted. An explicit `null` still clears the whole object -
 * that is the only way to remove individual keys. `experimentalFeatures` is merged one level
 * deeper (mirrors the client in UserSettingsContext); nothing else in the schema nests.
 */
function mergePreferences(
  stored: IUserPreferences | null | undefined,
  incoming: NonNullable<UpdateUserParameters['preferences']>
): IUserPreferences {
  const base = stored ?? {};
  return {
    ...base,
    ...incoming,
    ...(incoming.experimentalFeatures !== undefined && {
      experimentalFeatures: { ...base.experimentalFeatures, ...incoming.experimentalFeatures },
    }),
  };
}

/**
 * Who may take a reserved username (isReservedUsername): an admin editing an account passes
 * `allowReservedUsername: true`; a self-service change is checked by assertUsernameNotReserved.
 */
export type ReservedUsernamePolicy =
  | { allowReservedUsername: true }
  | { allowReservedUsername?: false; adminSettings?: Pick<IAdminSettingsRepository, 'findBySettingName'> };

/**
 * Validate a requested username change and normalize it in place on `params`. An absent or
 * unchanged username is left alone, so a legacy username that predates the rules never blocks
 * an unrelated profile save. Throws 400 on a rule violation or a reserved name the policy does not
 * allow, and 409 when another account holds the name case-insensitively.
 */
export async function validateUsernameChange(
  user: Pick<IUserDocument, 'id' | 'username' | 'email' | 'emailVerified'>,
  params: { username?: string },
  users: Pick<IUserRepository, 'existsOtherUserWithUsername'>,
  reserved: ReservedUsernamePolicy
): Promise<void> {
  if (params.username === undefined || params.username === user.username) return;

  const parsed = usernameSchema.safeParse(params.username);
  if (!parsed.success) {
    throw new BadRequestError(USERNAME_RULES_MESSAGE);
  }
  params.username = parsed.data;
  if (parsed.data === user.username) return;

  if (!reserved.allowReservedUsername) {
    await assertUsernameNotReserved(parsed.data, user.emailVerified ? user.email : null, reserved.adminSettings);
  }

  if (await users.existsOtherUserWithUsername(parsed.data, user.id)) {
    throw new ConflictError(USERNAME_TAKEN_MESSAGE);
  }
}

/** Run a user write, reporting a lost race on the username or email unique index as the same 409. */
export async function writeUserUpdate(
  users: Pick<IUserRepository, 'update'>,
  write: Partial<IUserDocument> & { id: string }
): Promise<void> {
  try {
    await users.update(write);
  } catch (error) {
    if (isDuplicateKeyErrorOn(error, 'username')) {
      throw new ConflictError(USERNAME_TAKEN_MESSAGE);
    }
    if (isDuplicateKeyErrorOn(error, 'email')) {
      throw new ConflictError(EMAIL_IN_USE_MESSAGE);
    }
    throw error;
  }
}

export async function updateUser(userId: string, parameters: UpdateUserParameters, { db }: UpdateUserAdapters) {
  const params = secureParameters(parameters, updateUserSchema);
  const userPassword = await db.users.findByIdWithPassword(userId);

  if (!userPassword) {
    throw new Error('User not found');
  }

  await validateUsernameChange(userPassword, params, db.users, { adminSettings: db.adminSettings });

  const updatedUser = applyBaseUserUpdates(userPassword, params);

  // Persist ONLY the fields this request changed. Writing the whole built document
  // (a spread of the read snapshot) is what let a routine profile save revert a
  // concurrent credit deduction, tokenVersion bump or admin tag/ban change.
  await writeUserUpdate(db.users, toUserUpdatePartial(updatedUser, params));
  return updatedUser;
}
