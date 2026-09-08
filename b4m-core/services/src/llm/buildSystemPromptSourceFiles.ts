export type SystemPromptFileSource = 'admin' | 'user' | 'project';

export type SystemPromptSourceFile = {
  fileId: string;
  fileName?: string;
  source: SystemPromptFileSource;
};

/**
 * Builds promptMeta.context.systemPromptSources: a file-level breakdown of every system-prompt
 * bucket (admin/global, user-enabled, project), tagged by source. `content` is deliberately never
 * populated - same leak-avoidance rule as extraContextMessages/systemPromptText elsewhere in
 * ChatCompletionProcess: the quest is serialized to the client on several read paths, so raw
 * prompt content has no business living on this field.
 *
 * No `session` bucket: the session-scoped file id set (sessionFabFileIds) is the user's workbench
 * attachments, not a system prompt source - it is already reported separately via
 * context.attachedFiles/context.sessionFileIds, and counting it here would double-count ordinary
 * attachments as "system prompts" in the UI's source breakdown.
 *
 * `fabFileNameById` resolves names for buckets whose files were fetched into convertedFabFiles
 * (message/user-enabled files share that fetch). Project files are fetched through a separate
 * path whose names never reach this point, so a project-sourced entry's fileName is left
 * undefined rather than paying for a second fetch just for display - the schema allows it.
 */
export function buildSystemPromptSourceFiles(
  fabFileNameById: Map<string, string>,
  buckets: { global: string[]; userEnabled: string[]; project: string[] }
): SystemPromptSourceFile[] | undefined {
  // enabled was previously hardcoded true for every entry (all three buckets are already-filtered
  // "included" sets, so it never varied) - dropped rather than kept as dead information; nothing
  // downstream reads it and the schema field is optional.
  const toEntries = (fileIds: string[], source: SystemPromptFileSource): SystemPromptSourceFile[] =>
    fileIds.map(fileId => ({ fileId, fileName: fabFileNameById.get(fileId), source }));

  const entries = [
    ...toEntries(buckets.global, 'admin'),
    ...toEntries(buckets.userEnabled, 'user'),
    ...toEntries(buckets.project, 'project'),
  ];

  // QuestModel.ts declares this field `default: undefined` specifically so an empty result
  // is never persisted - returning [] here would write an explicit empty array and defeat that.
  return entries.length > 0 ? entries : undefined;
}
