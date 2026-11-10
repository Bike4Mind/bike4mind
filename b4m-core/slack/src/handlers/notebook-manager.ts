import mongoose from 'mongoose';
import { Logger } from '@bike4mind/observability';
import {
  ISessionDocument,
  IKeywordRoutingRule,
  IProjectRepository,
  ISessionRepository,
  IUser,
  IUserDocument,
  canUpdateShareable,
} from '@bike4mind/common';
import { projectService } from '@bike4mind/services';
import { getSlackDeps, getSlackDb } from '../di/registry';

/**
 * Escapes special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isDuplicateKeyError(e: unknown): boolean {
  const { code, message } = (e ?? {}) as { code?: unknown; message?: unknown };
  return (
    code === 11000 || // MongoDB duplicate key error
    (typeof message === 'string' && (message.includes('duplicate') || message.includes('E11000')))
  );
}

/**
 * Find matching keyword rule (first match wins)
 * @param text - Message text to check
 * @param rules - Array of keyword routing rules (checked in order)
 * @returns notebookId if match found, null otherwise
 */
function findMatchingKeywordRule(text: string, rules: IKeywordRoutingRule[]): string | null {
  const lowerText = text.toLowerCase();

  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      // Word boundary matching to avoid partial matches
      // e.g. "acme" matches "acme" or "org/acme" but not "acmecorp"
      const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`, 'i');
      if (pattern.test(lowerText)) {
        return rule.notebookId;
      }
    }
  }
  return null;
}

/**
 * Resolves a saved notebook id (agent/keyword routing, slack default, web last notebook) to one the
 * user can still write to: it must exist, not be deleted, and pass the same write check as
 * canAccessSession(..., 'write') in packages/server-utils/src/utils/sessionAccess.ts (owner, update share by
 * user or group, isGlobalWrite). Admin rights are deliberately not honored, so a DM never lands in
 * another user's notebook. Returns null for a missing, malformed or denied id so the caller falls
 * through; lookup errors propagate rather than silently creating a new notebook.
 */
export async function resolveAccessibleNotebookId(
  Session: mongoose.Model<ISessionDocument>,
  notebookId: unknown,
  user: { id: string; groups?: string[] | null }
): Promise<string | null> {
  if (!notebookId) return null;
  const id = String(notebookId);
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  const notebook = await Session.findOne({ _id: id, deletedAt: null });
  if (notebook && (canUpdateShareable(notebook, user.id, user.groups ?? []) || notebook.isGlobalWrite)) {
    return notebook.id;
  }

  Logger.warn('[Slack Notebook Lookup] Ignoring saved notebook id the user cannot write to', {
    notebookId: id,
    userId: user.id,
  });
  return null;
}

/**
 * Helper function to update user's slack settings
 */
export async function updateUserSlackSettings(userId: string, slackSettings: NonNullable<IUser['slackSettings']>) {
  // DI exposes models as unknown; the bound implementations are the database Mongoose models.
  const User = getSlackDb().User as mongoose.Model<IUserDocument>;
  await User.findByIdAndUpdate(userId, { $set: { slackSettings } }, { new: true, upsert: false });
}

/**
 * Helper function to determine thread strategy for Slack bot replies
 * Implements thread-first architecture: event.thread_ts || event.ts
 */
export function determineThreadStrategy(event: { thread_ts?: string; ts: string }) {
  const replyThreadTs = event.thread_ts || event.ts;
  const isExistingThread = !!event.thread_ts;

  return { replyThreadTs, isExistingThread };
}

/**
 * Helper function to get or create notebook for slack user
 * Implements race condition handling with retry logic (3 attempts)
 * Supports thread-aware notebook mapping via channelId + threadTs
 * Supports per-agent notebook routing (Priority 0); saved notebook ids are access-checked
 */
export async function getOrCreateNotebookForSlackUser(
  userId: string,
  slackUserId: string,
  text: string,
  channelId: string,
  threadTs?: string,
  agentName?: string | null,
  workspaceId?: string // Slack workspace ID for async notification
): Promise<string> {
  const db = getSlackDb();
  const { sessionRepository, projectRepository, fabFileRepository, defineAbilitiesFor } = db;
  const User = db.User as mongoose.Model<IUserDocument>;
  const Session = db.Session as mongoose.Model<ISessionDocument>;
  const { sessionManager } = getSlackDeps();

  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  const slackSettings = user.slackSettings || {};

  // PRIORITY 0: Per-agent notebook routing
  if (agentName && slackSettings.agentNotebookRouting) {
    const agentNotebookId =
      slackSettings.agentNotebookRouting[agentName as keyof typeof slackSettings.agentNotebookRouting];
    const accessibleId = await resolveAccessibleNotebookId(Session, agentNotebookId, user);
    if (accessibleId) return accessibleId;
  }

  // PRIORITY 1: Keyword routing rules
  if (slackSettings.keywordRouting && slackSettings.keywordRouting.length > 0) {
    const matchedNotebookId = findMatchingKeywordRule(text || '', slackSettings.keywordRouting);

    const accessibleId = await resolveAccessibleNotebookId(Session, matchedNotebookId, user);
    if (accessibleId) return accessibleId;
  }

  // PRIORITY 2 & 3: find-or-create with retry. If a concurrent request creates the
  // notebook between our find and create, retry the find.
  if (channelId && slackSettings.autoCreateNotebook !== false) {
    const threadQuery: mongoose.FilterQuery<ISessionDocument> = {
      userId,
      'slackMetadata.channelId': channelId,
    };

    // If it's a threaded message, look for notebooks with matching threadTs
    // If it's NOT threaded (DM or channel message), look for notebooks without threadTs
    if (threadTs) {
      threadQuery['slackMetadata.threadTs'] = threadTs;
    } else {
      threadQuery['slackMetadata.threadTs'] = { $exists: false };
    }

    // Retry loop to handle race conditions
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Check for existing notebook
        const existingNotebook = await Session.findOne(threadQuery).sort({ lastUpdated: -1 });

        if (existingNotebook) {
          return existingNotebook.id;
        }

        // No existing notebook found - attempt to create
        const notebookName = threadTs
          ? `${slackSettings.notebookNamePrefix || 'Slack Thread'} - ${new Date().toLocaleDateString()}`
          : `${slackSettings.notebookNamePrefix || 'Slack Chat'} - ${new Date().toLocaleDateString()}`;

        const ability = defineAbilitiesFor(user);

        try {
          const newSession = await sessionManager.createSession(
            userId,
            {
              name: notebookName,
              origin: { channel: 'slack' },
              slackMetadata: {
                channelId,
                threadTs,
                createdFromSlack: true,
                workspaceId, // For async notification in Quest Processor
              },
            },
            ability,
            {
              setLastNotebook: true,
            }
          );

          // Assign to default project if configured
          if (slackSettings.defaultProjectId) {
            try {
              await projectService.addSessions(
                user,
                {
                  projectId: slackSettings.defaultProjectId,
                  sessionIds: [newSession.id],
                },
                {
                  db: {
                    sessions: sessionRepository as ISessionRepository,
                    projects: projectRepository as IProjectRepository,
                    fabFiles: fabFileRepository,
                  },
                }
              );
            } catch (error) {
              // Don't fail notebook creation if project assignment fails
              // The project might have been deleted or user might not have access
              Logger.error('⚠️ [Slack Notebook Lookup] Failed to assign notebook to project, continuing anyway', {
                notebookId: newSession.id,
                projectId: slackSettings.defaultProjectId,
                error: errorMessage(error),
              });
            }
          }

          // Only update defaultNotebookId for non-threaded messages
          if (!threadTs) {
            await updateUserSlackSettings(userId, {
              ...slackSettings,
              slackUserId,
              defaultNotebookId: newSession.id,
            });
          }

          return newSession.id;
        } catch (createError) {
          // Check if this is a duplicate key error (race condition)
          const isDuplicateError = isDuplicateKeyError(createError);

          if (isDuplicateError && attempt < MAX_RETRIES) {
            Logger.warn('⚠️ [Slack Notebook Lookup] Race condition detected - another request created notebook', {
              attempt,
              willRetry: true,
              error: errorMessage(createError),
            });
            // Retry the find operation - the other request's notebook should now exist
            continue;
          }

          // Not a duplicate error, or we've exhausted retries
          throw createError;
        }
      } catch (error) {
        // Only retry if it's a duplicate error and we haven't exceeded retries
        const isDuplicateError = isDuplicateKeyError(error);

        if (!isDuplicateError || attempt === MAX_RETRIES) {
          Logger.error('❌ [Slack Notebook Lookup] Failed to find or create notebook', {
            error,
            attempt,
            isDuplicateError,
          });
          throw error;
        }

        Logger.warn('⚠️ [Slack Notebook Lookup] Duplicate error in outer catch, retrying', {
          error: errorMessage(error),
          attempt,
        });
        // Continue to next retry for duplicate errors
      }
    }

    // This should never be reached due to throw in the loop, but TypeScript needs it
    throw new Error('Failed to find or create notebook after maximum retries');
  } else if (channelId) {
    // Auto-create is disabled, just try to find existing notebook
    try {
      const threadQuery: mongoose.FilterQuery<ISessionDocument> = {
        userId,
        'slackMetadata.channelId': channelId,
      };

      if (threadTs) {
        threadQuery['slackMetadata.threadTs'] = threadTs;
      } else {
        threadQuery['slackMetadata.threadTs'] = { $exists: false };
      }

      const existingNotebook = await Session.findOne(threadQuery).sort({ lastUpdated: -1 });

      if (existingNotebook) {
        return existingNotebook.id;
      }
    } catch (error) {
      Logger.error('⚠️ [Slack Notebook Lookup] Error finding notebook:', error);
      // Fall through to other lookup methods
    }
  }

  // PRIORITY 3: Fallback to user's slack default notebook (set via /notebook set)
  const defaultNotebookId = await resolveAccessibleNotebookId(Session, slackSettings.defaultNotebookId, user);
  if (defaultNotebookId) return defaultNotebookId;

  // PRIORITY 4: Fallback to user's last notebook (from web app)
  const lastNotebookId = await resolveAccessibleNotebookId(Session, user.lastNotebookId, user);
  if (lastNotebookId) return lastNotebookId;

  // PRIORITY 5: Create a default notebook as last resort
  const fallbackNotebookName = threadTs
    ? `${slackSettings.notebookNamePrefix || 'Slack Thread'} - ${new Date().toLocaleDateString()}`
    : `${slackSettings.notebookNamePrefix || 'Slack Chat'} - ${new Date().toLocaleDateString()}`;

  const ability = defineAbilitiesFor(user);
  const defaultSession = await sessionManager.createSession(
    userId,
    {
      ...sessionManager.getDefaultSession(userId),
      name: fallbackNotebookName,
      origin: { channel: 'slack' },
      slackMetadata: {
        channelId,
        threadTs,
        createdFromSlack: true,
        workspaceId, // For async notification in Quest Processor
      },
    },
    ability,
    {
      setLastNotebook: true,
    }
  );

  // Assign to default project if configured
  if (slackSettings.defaultProjectId) {
    try {
      await projectService.addSessions(
        user,
        {
          projectId: slackSettings.defaultProjectId,
          sessionIds: [defaultSession.id],
        },
        {
          db: {
            sessions: sessionRepository as ISessionRepository,
            projects: projectRepository as IProjectRepository,
            fabFiles: fabFileRepository,
          },
        }
      );
    } catch (error) {
      Logger.warn('⚠️ [Slack Notebook Lookup] Failed to assign default notebook to project', {
        notebookId: defaultSession.id,
        projectId: slackSettings.defaultProjectId,
        error: errorMessage(error),
      });
    }
  }

  return defaultSession.id;
}
