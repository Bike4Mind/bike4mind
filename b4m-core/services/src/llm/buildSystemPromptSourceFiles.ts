export type SystemPromptFileSource = 'admin' | 'user' | 'project' | 'session';

export type SystemPromptSourceFile = {
  fileId: string;
  fileName?: string;
  source: SystemPromptFileSource;
  enabled: boolean;
};

/**
 * Builds promptMeta.context.systemPromptSources: a file-level breakdown of every system-prompt
 * bucket (admin/global, user-enabled, project, session), tagged by source. `content` is
 * deliberately never populated - same leak-avoidance rule as extraContextMessages/systemPromptText
 * elsewhere in ChatCompletionProcess: the quest is serialized to the client on several read paths,
 * so raw prompt content has no business living on this field.
 *
 * `fabFileNameById` resolves names for buckets whose files were fetched into convertedFabFiles
 * (session/message/user-enabled). Project files are fetched through a separate path whose names
 * never reach this point, so a project-sourced entry's fileName is left undefined rather than
 * paying for a second fetch just for display - the schema allows it.
 */
export function buildSystemPromptSourceFiles(
  fabFileNameById: Map<string, string>,
  buckets: { global: string[]; userEnabled: string[]; project: string[]; session: string[] }
): SystemPromptSourceFile[] {
  const toEntries = (fileIds: string[], source: SystemPromptFileSource): SystemPromptSourceFile[] =>
    fileIds.map(fileId => ({ fileId, fileName: fabFileNameById.get(fileId), source, enabled: true }));

  return [
    ...toEntries(buckets.global, 'admin'),
    ...toEntries(buckets.userEnabled, 'user'),
    ...toEntries(buckets.project, 'project'),
    ...toEntries(buckets.session, 'session'),
  ];
}
