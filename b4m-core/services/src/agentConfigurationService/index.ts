import { z } from 'zod';
import { FavoriteDocumentType, McpServerName, checkSkillFiles } from '@bike4mind/common';
import type {
  IAgentDocument,
  IBriefcasePromptDocument,
  IFavorite,
  IMcpServerDocument,
  IProjectDocument,
  ISessionToolApprovalDocument,
  ISkillDocument,
  IUser,
  IUserPreferences,
} from '@bike4mind/common';

type AgentFields = Pick<
  IAgentDocument,
  | 'id'
  | 'name'
  | 'description'
  | 'type'
  | 'triggerWords'
  | 'capabilities'
  | 'systemPrompt'
  | 'allowedTools'
  | 'deniedTools'
  | 'maxIterations'
  | 'defaultThoroughness'
  | 'confidenceGateThreshold'
  | 'confidenceGateMode'
  | 'confidenceGateSelfReport'
  | 'exclusiveMcpServers'
  | 'fallbackModels'
  | 'preferredModel'
  | 'preferredImageModel'
  | 'temperature'
  | 'maxTokens'
  | 'personality'
  | 'visual'
  | 'identity'
  | 'projectId'
>;
type Agent = Omit<AgentFields, 'visual'> & { visual?: Omit<AgentFields['visual'], 'portraitUrl'> };
type Skill = Pick<
  ISkillDocument,
  | 'id'
  | 'name'
  | 'description'
  | 'body'
  | 'argumentHint'
  | 'allowedTools'
  | 'claudeCodeAllowedTools'
  | 'claudeCodeModel'
  | 'disableModelInvocation'
  | 'files'
>;
type Project = Pick<IProjectDocument, 'id' | 'name' | 'description' | 'sessionIds' | 'fileIds' | 'systemPrompts'>;
type Prompt = Pick<
  IBriefcasePromptDocument,
  'id' | 'type' | 'name' | 'description' | 'promptText' | 'tags' | 'executionMode' | 'requiredTools' | 'schemaVersion'
>;
type McpServer = Pick<IMcpServerDocument, 'name'> & { envVariableKeys: string[] };
type Approval = Pick<ISessionToolApprovalDocument, 'sessionId' | 'deniedTools'>;
type Favorite = Pick<IFavorite, 'documentId' | 'documentType'>;
type Preferences = Pick<
  IUserPreferences,
  | 'language'
  | 'favoriteTags'
  | 'favoriteModelIds'
  | 'hiddenSurfaces'
  | 'fileBrowserViewMode'
  | 'lastUsedTextModel'
  | 'lastUsedImageModel'
  | 'lastUsedImageEditModel'
  | 'showDebug'
  | 'showHelp'
  | 'maxVisibleLines'
  | 'autoCollapseContent'
  | 'enableAutoScroll'
  | 'scrollbarWidth'
  | 'rechartsDisplayMode'
  | 'toolsCatalogCollapsed'
  | 'agentModeDefault'
  | 'showFunTools'
  | 'showSplashCards'
  | 'desktopPromoDismissed'
  | 'promptCacheTtl'
  | 'pushNotifications'
>;

export interface AgentConfigurationArchive {
  agents: Agent[];
  skills: Skill[];
  projects: Project[];
  prompts: Prompt[];
  mcpServers: McpServer[];
  sessionToolApprovals: Approval[];
  favorites: Favorite[];
  profile: { name: string; preferences: Preferences };
}

const strings = z.array(z.string());
const looseObject = z.record(z.string(), z.unknown());

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(['persona', 'voice']).optional(),
  triggerWords: strings.optional(),
  capabilities: strings.optional(),
  systemPrompt: z.string().optional(),
  allowedTools: strings.optional(),
  deniedTools: strings.optional(),
  maxIterations: z.object({ quick: z.number(), medium: z.number(), very_thorough: z.number() }).optional(),
  defaultThoroughness: z.string().optional(),
  confidenceGateThreshold: z.number().optional(),
  confidenceGateMode: z.string().optional(),
  confidenceGateSelfReport: z.boolean().optional(),
  exclusiveMcpServers: strings.optional(),
  fallbackModels: strings.optional(),
  preferredModel: z.string().optional(),
  preferredImageModel: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  personality: looseObject.optional(),
  visual: looseObject.optional(),
  identity: looseObject.optional(),
  projectId: z.string().optional(),
});

const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  body: z.string(),
  argumentHint: z.string().optional(),
  allowedTools: strings.optional(),
  claudeCodeAllowedTools: strings.optional(),
  claudeCodeModel: z.string().optional(),
  disableModelInvocation: z.boolean().optional(),
  files: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .superRefine((files, ctx) => {
      const check = checkSkillFiles(files);
      if (!check.ok) ctx.addIssue({ code: 'custom', message: check.error });
    })
    .optional(),
});

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  sessionIds: strings,
  fileIds: strings,
  systemPrompts: z.array(z.object({ fileId: z.string(), enabled: z.boolean() })),
});

const promptSchema = z.object({
  id: z.string(),
  type: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  promptText: z.string(),
  tags: strings.optional(),
  executionMode: z.string().optional(),
  requiredTools: strings.optional(),
  schemaVersion: z.number().optional(),
});

export const agentConfigurationArchiveSchema = z.object({
  agents: z.array(agentSchema),
  skills: z.array(skillSchema),
  projects: z.array(projectSchema),
  prompts: z.array(promptSchema),
  mcpServers: z.array(z.object({ name: z.enum(McpServerName), envVariableKeys: strings })),
  sessionToolApprovals: z.array(z.object({ sessionId: z.string(), deniedTools: strings })),
  favorites: z.array(z.object({ documentId: z.string(), documentType: z.enum(FavoriteDocumentType) })),
  profile: z.object({ name: z.string(), preferences: looseObject }),
});

type Query = Record<string, unknown>;
interface Reader<T> {
  find(query: Query): Promise<T[]>;
}
interface Writer<T> {
  create(data: T): Promise<{ id: string }>;
}

export interface AgentConfigurationExportAdapters {
  agents: Reader<IAgentDocument>;
  skills: Reader<ISkillDocument>;
  projects: Reader<IProjectDocument>;
  prompts: Reader<IBriefcasePromptDocument>;
  mcpServers: Reader<IMcpServerDocument>;
  sessionToolApprovals: Reader<ISessionToolApprovalDocument>;
  favorites: Reader<IFavorite>;
  users: { findById(id: string): Promise<Pick<IUser, 'name' | 'preferences'> | null> };
}

export interface AgentConfigurationImportAdapters {
  agents: Writer<Omit<Agent, 'id' | 'projectId'> & { userId: string; projectId?: string }>;
  skills: Writer<Omit<Skill, 'id'> & { userId: string }>;
  projects: Writer<Omit<Project, 'id'> & { userId: string }>;
  prompts: Writer<Omit<Prompt, 'id'> & { userId: string }>;
  mcpServers: Writer<Pick<IMcpServerDocument, 'name' | 'userId' | 'enabled' | 'envVariables' | 'tools'>>;
  sessionToolApprovals: Writer<Approval & { userId: string; approvedTools: string[] }>;
  favorites: Writer<Favorite & { userId: string }>;
  users: { updateById(id: string, patch: { name: string; preferences: Preferences }): Promise<unknown> };
}

const preferencesOf = (value: IUserPreferences | null | undefined): Preferences => {
  const {
    language,
    favoriteTags,
    favoriteModelIds,
    hiddenSurfaces,
    fileBrowserViewMode,
    lastUsedTextModel,
    lastUsedImageModel,
    lastUsedImageEditModel,
    showDebug,
    showHelp,
    maxVisibleLines,
    autoCollapseContent,
    enableAutoScroll,
    scrollbarWidth,
    rechartsDisplayMode,
    toolsCatalogCollapsed,
    agentModeDefault,
    showFunTools,
    showSplashCards,
    desktopPromoDismissed,
    promptCacheTtl,
    pushNotifications,
  } = value ?? {};
  return {
    language,
    favoriteTags,
    favoriteModelIds,
    hiddenSurfaces,
    fileBrowserViewMode,
    lastUsedTextModel,
    lastUsedImageModel,
    lastUsedImageEditModel,
    showDebug,
    showHelp,
    maxVisibleLines,
    autoCollapseContent,
    enableAutoScroll,
    scrollbarWidth,
    rechartsDisplayMode,
    toolsCatalogCollapsed,
    agentModeDefault,
    showFunTools,
    showSplashCards,
    desktopPromoDismissed,
    promptCacheTtl,
    pushNotifications,
  };
};

const agentOf = (row: Agent): Agent => ({
  id: row.id,
  name: row.name,
  description: row.description,
  type: row.type,
  triggerWords: row.triggerWords,
  capabilities: row.capabilities,
  systemPrompt: row.systemPrompt,
  allowedTools: row.allowedTools,
  deniedTools: row.deniedTools,
  maxIterations: row.maxIterations,
  defaultThoroughness: row.defaultThoroughness,
  confidenceGateThreshold: row.confidenceGateThreshold,
  confidenceGateMode: row.confidenceGateMode,
  confidenceGateSelfReport: row.confidenceGateSelfReport,
  exclusiveMcpServers: row.exclusiveMcpServers,
  fallbackModels: row.fallbackModels,
  preferredModel: row.preferredModel,
  preferredImageModel: row.preferredImageModel,
  temperature: row.temperature,
  maxTokens: row.maxTokens,
  personality: row.personality,
  visual: row.visual && { style: row.visual.style, generationPrompt: row.visual.generationPrompt },
  identity: row.identity,
  projectId: row.projectId,
});

const skillOf = (row: Skill): Skill => ({
  id: row.id,
  name: row.name,
  description: row.description,
  body: row.body,
  argumentHint: row.argumentHint,
  allowedTools: row.allowedTools,
  claudeCodeAllowedTools: row.claudeCodeAllowedTools,
  claudeCodeModel: row.claudeCodeModel,
  disableModelInvocation: row.disableModelInvocation,
  files: row.files,
});

const promptOf = (row: Prompt): Prompt => ({
  id: row.id,
  type: row.type,
  name: row.name,
  description: row.description,
  promptText: row.promptText,
  tags: row.tags,
  executionMode: row.executionMode,
  requiredTools: row.requiredTools,
  schemaVersion: row.schemaVersion,
});

export async function exportAgentConfiguration(
  userId: string,
  db: AgentConfigurationExportAdapters
): Promise<AgentConfigurationArchive> {
  const [agents, skills, projects, prompts, mcpServers, approvals, favorites, user] = await Promise.all([
    db.agents.find({ userId, deletedAt: null }),
    db.skills.find({ userId, deletedAt: null }),
    db.projects.find({ userId, deletedAt: null }),
    db.prompts.find({ userId, deletedAt: null }),
    db.mcpServers.find({ userId }),
    db.sessionToolApprovals.find({ userId }),
    db.favorites.find({ userId }),
    db.users.findById(userId),
  ]);
  if (!user) throw new Error('Account not found');

  return {
    agents: agents.filter(row => row.userId === userId && !row.deletedAt && row.type !== 'voice').map(agentOf),
    skills: skills.filter(row => row.userId === userId && !row.deletedAt).map(skillOf),
    projects: projects
      .filter(row => row.userId === userId && !row.deletedAt)
      .map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        sessionIds: row.sessionIds ?? [],
        fileIds: row.fileIds ?? [],
        systemPrompts: (row.systemPrompts ?? []).map(prompt => ({ fileId: prompt.fileId, enabled: prompt.enabled })),
      })),
    prompts: prompts.filter(row => row.userId === userId && !row.deletedAt).map(promptOf),
    mcpServers: mcpServers
      .filter(row => row.userId === userId)
      .map(row => ({ name: row.name, envVariableKeys: row.envVariables.map(item => item.key) })),
    sessionToolApprovals: approvals
      .filter(row => row.userId === userId)
      .map(row => ({ sessionId: row.sessionId, deniedTools: row.deniedTools })),
    favorites: favorites
      .filter(row => row.userId === userId)
      .map(row => ({ documentId: row.documentId, documentType: row.documentType })),
    profile: { name: user.name, preferences: preferencesOf(user.preferences) },
  };
}

export interface AgentConfigurationReferenceMap {
  sessions?: ReadonlyMap<string, string>;
  files?: ReadonlyMap<string, string>;
}

/**
 * Validates the archive shape, then writes it for `userId`. Callers must still run their own caller-context
 * checks (agent validators, model entitlement; see validateAgentUpdate in apps/client/server/utils/agentValidation.ts).
 */
export async function importAgentConfiguration(
  userId: string,
  rawArchive: AgentConfigurationArchive,
  db: AgentConfigurationImportAdapters,
  references: AgentConfigurationReferenceMap = {}
): Promise<{
  projects: Map<string, string>;
  agents: Map<string, string>;
  skills: Map<string, string>;
  prompts: Map<string, string>;
}> {
  const archive = agentConfigurationArchiveSchema.parse(rawArchive) as AgentConfigurationArchive;
  const projects = new Map<string, string>();
  const agents = new Map<string, string>();
  const skills = new Map<string, string>();
  const prompts = new Map<string, string>();

  for (const row of archive.projects) {
    const { id, name, description, sessionIds, fileIds, systemPrompts } = row;
    projects.set(
      id,
      (
        await db.projects.create({
          name,
          description,
          userId,
          sessionIds: sessionIds.flatMap(sourceId => {
            const mapped = references.sessions?.get(sourceId);
            return mapped ? [mapped] : [];
          }),
          fileIds: fileIds.flatMap(sourceId => {
            const mapped = references.files?.get(sourceId);
            return mapped ? [mapped] : [];
          }),
          systemPrompts: systemPrompts.flatMap(prompt => {
            const fileId = references.files?.get(prompt.fileId);
            return fileId ? [{ fileId, enabled: prompt.enabled }] : [];
          }),
        })
      ).id
    );
  }
  for (const row of archive.agents) {
    if (row.type === 'voice') continue;
    const { id, projectId: sourceProjectId } = row;
    const { projectId: _projectId, id: _id, ...config } = agentOf(row);
    const projectId = sourceProjectId ? projects.get(sourceProjectId) : undefined;
    agents.set(id, (await db.agents.create({ ...config, userId, ...(projectId ? { projectId } : {}) })).id);
  }
  for (const row of archive.skills) {
    const { id: _id, ...config } = skillOf(row);
    skills.set(row.id, (await db.skills.create({ ...config, userId })).id);
  }
  for (const row of archive.prompts) {
    const { id: _id, ...config } = promptOf(row);
    prompts.set(row.id, (await db.prompts.create({ ...config, userId })).id);
  }
  for (const row of archive.mcpServers) {
    await db.mcpServers.create({ name: row.name, userId, enabled: false, envVariables: [], tools: [] });
  }
  for (const row of archive.sessionToolApprovals) {
    const sessionId = references.sessions?.get(row.sessionId);
    if (sessionId) {
      await db.sessionToolApprovals.create({ userId, sessionId, approvedTools: [], deniedTools: row.deniedTools });
    }
  }
  for (const row of archive.favorites) {
    const documentId =
      row.documentType === 'projects'
        ? projects.get(row.documentId)
        : row.documentType === 'sessions'
          ? references.sessions?.get(row.documentId)
          : references.files?.get(row.documentId);
    if (documentId) await db.favorites.create({ userId, documentId, documentType: row.documentType });
  }
  await db.users.updateById(userId, {
    name: archive.profile.name,
    preferences: preferencesOf(archive.profile.preferences),
  });
  return { projects, agents, skills, prompts };
}
