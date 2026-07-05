import mongoose from 'mongoose';
import { Logger } from '@bike4mind/observability';
import { ISessionDocument, IKeywordRoutingRule } from '@bike4mind/common';
import { projectService } from '@bike4mind/services';
import { getSlackDeps, getSlackDb } from '../di/registry';

/**
 * Escapes special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
      // "lumina5" matches "lumina5" or "MillionOnMars/lumina5" but not "luminacy"
      const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`, 'i');
      if (pattern.test(lowerText)) {
        return rule.notebookId;
      }
    }
  }
  return null;
}

/**
 * Helper function to update user's slack settings
 */
export async function updateUserSlackSettings(userId: string, slackSettings: any) {
  const { User } = getSlackDb();
  await (User as any).findByIdAndUpdate(userId, { $set: { slackSettings } }, { new: true, upsert: false });
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
 * Supports per-agent notebook routing (Priority 0)
 */
export async function getOrCreateNotebookForSlackUser(
  userId: string,
  slackUserId: string,
  text: string,
  channelId: string,
  threadTs?: string,
  agentName?: string | null,
  workspaceId?: string // Slack workspace ID for async notification
) {
  const { User, Session, sessionRepository, projectRepository, fabFileRepository, defineAbilitiesFor } = getSlackDb();
  const { sessionManager } = getSlackDeps();

  const user = await (User as any).findById(userId);
  if (!user) throw new Error('User not found');

  const slackSettings = user.slackSettings || {};

  // PRIORITY 0: Per-agent notebook routing
  if (agentName && slackSettings.agentNotebookRouting) {
    const agentNotebookId =
      slackSettings.agentNotebookRouting[agentName as keyof typeof slackSettings.agentNotebookRouting];
    if (agentNotebookId) {
      return agentNotebookId.toString();
    }
  }

  // PRIORITY 1: Keyword routing rules
  if (slackSettings.keywordRouting && slackSettings.keywordRouting.length > 0) {
    const matchedNotebookId = findMatchingKeywordRule(text || '', slackSettings.keywordRouting);

    if (matchedNotebookId) {
      // Verify the notebook still exists and belongs to user
      const notebook = await (Session as any).findOne({
        _id: matchedNotebookId,
        userId: userId,
        deletedAt: { $exists: false },
      });

      if (notebook) {
        return notebook.id;
      }
    }
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
        const existingNotebook = await (Session as any).findOne(threadQuery).sort({ lastUpdated: -1 });

        if (existingNotebook) {
          return existingNotebook.id;
        }

        // No existing notebook found - attempt to create
        const notebookName = threadTs
          ? `${slackSettings.notebookNamePrefix || 'Slack Thread'} - ${new Date().toLocaleDateString()}`
          : `${slackSettings.notebookNamePrefix || 'Slack Chat'} - ${new Date().toLocaleDateString()}`;

        const ability = defineAbilitiesFor(user);

        try {
          const newSession = await (sessionManager as any).createSession(
            userId,
            {
              name: notebookName,
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
                    sessions: sessionRepository as any,
                    projects: projectRepository as any,
                    fabFiles: fabFileRepository as any,
                  },
                }
              );
            } catch (error: any) {
              // Don't fail notebook creation if project assignment fails
              // The project might have been deleted or user might not have access
              Logger.error('⚠️ [Slack Notebook Lookup] Failed to assign notebook to project, continuing anyway', {
                notebookId: newSession.id,
                projectId: slackSettings.defaultProjectId,
                error: error.message,
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
        } catch (createError: any) {
          // Check if this is a duplicate key error (race condition)
          const isDuplicateError =
            createError.code === 11000 || // MongoDB duplicate key error
            createError.message?.includes('duplicate') ||
            createError.message?.includes('E11000');

          if (isDuplicateError && attempt < MAX_RETRIES) {
            Logger.warn('⚠️ [Slack Notebook Lookup] Race condition detected - another request created notebook', {
              attempt,
              willRetry: true,
              error: createError.message,
            });
            // Retry the find operation - the other request's notebook should now exist
            continue;
          }

          // Not a duplicate error, or we've exhausted retries
          throw createError;
        }
      } catch (error: any) {
        // Only retry if it's a duplicate error and we haven't exceeded retries
        const isDuplicateError =
          error.code === 11000 || error.message?.includes('duplicate') || error.message?.includes('E11000');

        if (!isDuplicateError || attempt === MAX_RETRIES) {
          Logger.error('❌ [Slack Notebook Lookup] Failed to find or create notebook', {
            error,
            attempt,
            isDuplicateError,
          });
          throw error;
        }

        Logger.warn('⚠️ [Slack Notebook Lookup] Duplicate error in outer catch, retrying', {
          error: error.message,
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

      const existingNotebook = await (Session as any).findOne(threadQuery).sort({ lastUpdated: -1 });

      if (existingNotebook) {
        return existingNotebook.id;
      }
    } catch (error) {
      Logger.error('⚠️ [Slack Notebook Lookup] Error finding notebook:', error);
      // Fall through to other lookup methods
    }
  }

  // PRIORITY 3: Fallback to user's slack default notebook (set via /notebook set)
  if (slackSettings.defaultNotebookId) {
    return slackSettings.defaultNotebookId.toString();
  }

  // PRIORITY 4: Fallback to user's last notebook (from web app)
  if (user.lastNotebookId) {
    return user.lastNotebookId.toString();
  }

  // PRIORITY 5: Create a default notebook as last resort
  const fallbackNotebookName = threadTs
    ? `${slackSettings.notebookNamePrefix || 'Slack Thread'} - ${new Date().toLocaleDateString()}`
    : `${slackSettings.notebookNamePrefix || 'Slack Chat'} - ${new Date().toLocaleDateString()}`;

  const ability = defineAbilitiesFor(user);
  const defaultSession = await (sessionManager as any).createSession(
    userId,
    {
      ...sessionManager.getDefaultSession(userId),
      name: fallbackNotebookName,
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
            sessions: sessionRepository as any,
            projects: projectRepository as any,
            fabFiles: fabFileRepository as any,
          },
        }
      );
    } catch (error: any) {
      Logger.warn('⚠️ [Slack Notebook Lookup] Failed to assign default notebook to project', {
        notebookId: defaultSession.id,
        projectId: slackSettings.defaultProjectId,
        error: error.message,
      });
    }
  }

  return defaultSession.id;
}
