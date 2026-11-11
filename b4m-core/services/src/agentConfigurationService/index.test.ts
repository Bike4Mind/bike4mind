import { describe, expect, it, vi } from 'vitest';
import type {
  AgentConfigurationArchive,
  AgentConfigurationExportAdapters,
  AgentConfigurationImportAdapters,
} from './index';
import { AgentConfigurationImportError, exportAgentConfiguration, importAgentConfiguration } from './index';

const agent = {
  id: 'agent-old',
  userId: 'source',
  name: 'Helper',
  description: 'Helpful agent',
  systemPrompt: 'Follow these instructions',
  triggerWords: ['help'],
  capabilities: ['research'],
  projectId: 'project-old',
  personality: { majorMotivation: 'help' },
  defaultVariables: { API_KEY: 'secret' },
  currentCredits: 500,
  users: [{ userId: 'other' }],
};

function exportAdapters(): AgentConfigurationExportAdapters {
  const find = (rows: unknown[]) => vi.fn().mockResolvedValue(rows);
  return {
    agents: {
      find: find([
        agent,
        { ...agent, id: 'foreign-agent', userId: 'other' },
        { ...agent, id: 'deleted', deletedAt: new Date() },
      ]),
    },
    skills: {
      find: find([
        { id: 'skill-old', userId: 'source', name: 'Search', description: 'Look up', body: 'Search safely', files: [] },
        { id: 'system-skill', isSystem: true, name: 'Internal', body: 'Private' },
      ]),
    },
    projects: {
      find: find([
        {
          id: 'project-old',
          userId: 'source',
          name: 'My project',
          description: 'Notes',
          sessionIds: ['session-old', 'foreign-session'],
          fileIds: ['file-old', 'foreign-file'],
          systemPrompts: [{ fileId: 'file-old', enabled: true, internalNote: 'hidden-project-value' }],
          users: [{ userId: 'other' }],
        },
      ]),
    },
    prompts: {
      find: find([
        {
          id: 'prompt-old',
          userId: 'source',
          type: 'personal',
          name: 'My prompt',
          promptText: 'Hello',
          tags: ['mine'],
        },
        { id: 'system-prompt', userId: null, promptText: 'Secret system content' },
      ]),
    },
    mcpServers: {
      find: find([
        {
          userId: 'source',
          name: 'github',
          envVariables: [{ key: 'GITHUB_TOKEN', value: 'connection-secret' }],
          metadata: { webhooks: { github: { routingToken: 'routing-secret', secret: 'webhook-secret' } } },
          toolSchemas: [{ input_schema: { token: 'schema-secret' } }],
        },
      ]),
    },
    sessionToolApprovals: {
      find: find([{ userId: 'source', sessionId: 'session-old', approvedTools: ['bash'], deniedTools: ['delete'] }]),
    },
    favorites: { find: find([{ userId: 'source', documentId: 'project-old', documentType: 'projects' }]) },
    users: {
      findById: vi.fn().mockResolvedValue({
        name: 'Owner',
        preferences: {
          agentModeDefault: 'auto',
          optiSessionId: 'other-session',
          experimentalFeatures: { adminOnly: true },
          docxTemplateFileId: 'foreign-file',
        },
        oauthCredentials: { accessToken: 'oauth-secret' },
        password: 'password-secret',
      }),
    },
  } as unknown as AgentConfigurationExportAdapters;
}

function importAdapters(): AgentConfigurationImportAdapters {
  const create = (name: string) => vi.fn().mockResolvedValue({ id: `${name}-new` });
  const collection = (name: string) => ({ create: create(name), findOne: vi.fn().mockResolvedValue(null) });
  return {
    agents: collection('agent'),
    skills: collection('skill'),
    projects: collection('project'),
    prompts: collection('prompt'),
    mcpServers: collection('mcp'),
    sessionToolApprovals: collection('approval'),
    favorites: collection('favorite'),
    users: { updatePreferences: vi.fn() },
  } as unknown as AgentConfigurationImportAdapters;
}

describe('agent configuration egress', () => {
  it('scopes every collection to the owner and exports no secrets or shares', async () => {
    const db = exportAdapters();
    const archive = await exportAgentConfiguration('source', db);

    for (const collection of [
      'agents',
      'skills',
      'projects',
      'prompts',
      'mcpServers',
      'sessionToolApprovals',
      'favorites',
    ] as const) {
      expect(db[collection].find).toHaveBeenCalledWith(expect.objectContaining({ userId: 'source' }));
    }
    expect(archive.agents).toHaveLength(1);
    expect(archive.skills).toHaveLength(1);
    expect(archive.prompts).toHaveLength(1);
    expect(archive.agents[0]).toMatchObject({
      name: 'Helper',
      systemPrompt: 'Follow these instructions',
      projectId: 'project-old',
    });
    expect(archive.mcpServers).toEqual([{ name: 'github', envVariableKeys: ['GITHUB_TOKEN'] }]);
    expect(archive.sessionToolApprovals).toEqual([{ sessionId: 'session-old', deniedTools: ['delete'] }]);
    expect(archive.projects[0]).toEqual({
      id: 'project-old',
      name: 'My project',
      description: 'Notes',
      sessionIds: ['session-old', 'foreign-session'],
      fileIds: ['file-old', 'foreign-file'],
      systemPrompts: [{ fileId: 'file-old', enabled: true }],
    });
    expect(archive.profile).toEqual({
      name: 'Owner',
      preferences: expect.objectContaining({ agentModeDefault: 'auto' }),
    });
    const json = JSON.stringify(archive);
    for (const secret of [
      'connection-secret',
      'webhook-secret',
      'routing-secret',
      'schema-secret',
      'oauth-secret',
      'password-secret',
      'adminOnly',
      'API_KEY',
      'hidden-project-value',
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('restores personal configuration with fresh IDs and never carries grants or stale references', async () => {
    const archive = await exportAgentConfiguration('source', exportAdapters());
    const db = importAdapters();
    const ids = await importAgentConfiguration('target', archive, db, {
      sessions: new Map([['session-old', 'session-new']]),
      files: new Map([['file-old', 'file-new']]),
    });

    expect(ids.projects.get('project-old')).toBe('project-new');
    expect(ids.agents.get('agent-old')).toBe('agent-new');
    expect(ids.skills.get('skill-old')).toBe('skill-new');
    expect(ids.prompts.get('prompt-old')).toBe('prompt-new');
    expect(db.projects.create).toHaveBeenCalledWith({
      name: 'My project',
      description: 'Notes',
      userId: 'target',
      sessionIds: ['session-new'],
      fileIds: ['file-new'],
      systemPrompts: [{ fileId: 'file-new', enabled: true }],
    });
    expect(db.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'target', projectId: 'project-new', systemPrompt: 'Follow these instructions' })
    );
    expect(db.skills.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'target', name: 'Search' }));
    expect(db.prompts.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'target', name: 'My prompt' }));
    expect(db.mcpServers.create).toHaveBeenCalledWith({
      name: 'github',
      userId: 'target',
      enabled: false,
      envVariables: [],
      tools: [],
    });
    expect(db.sessionToolApprovals.create).toHaveBeenCalledWith({
      userId: 'target',
      sessionId: 'session-new',
      approvedTools: [],
      deniedTools: ['delete'],
    });
    expect(db.favorites.create).toHaveBeenCalledWith({
      userId: 'target',
      documentId: 'project-new',
      documentType: 'projects',
    });
    expect(db.users.updatePreferences).toHaveBeenCalledWith('target', { agentModeDefault: 'auto' });
    expect(JSON.stringify(vi.mocked(db.agents.create).mock.calls)).not.toContain('API_KEY');
  });

  it('ignores unmapped external references and strips injected owner, secret and scope fields', async () => {
    const archive = await exportAgentConfiguration('source', exportAdapters());
    const injected = {
      ...archive,
      agents: [
        {
          ...archive.agents[0],
          id: 'toString',
          projectId: 'someone-elses-project',
          userId: 'other',
          organizationId: 'other-org',
          isSystem: true,
          defaultVariables: { TOKEN: 'injected' },
        },
      ],
      skills: [{ ...archive.skills[0], userId: 'other', isSystem: true }],
      prompts: [{ ...archive.prompts[0], userId: 'other' }],
    } as AgentConfigurationArchive;
    const db = importAdapters();
    await importAgentConfiguration('target', injected, db);

    expect(db.agents.create).toHaveBeenCalledWith(expect.not.objectContaining({ projectId: 'someone-elses-project' }));
    expect(db.agents.create).toHaveBeenCalledWith(expect.not.objectContaining({ organizationId: 'other-org' }));
    expect(db.agents.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ defaultVariables: { TOKEN: 'injected' } })
    );
    expect(db.sessionToolApprovals.create).not.toHaveBeenCalled();
    expect(db.projects.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: [], fileIds: [], systemPrompts: [] })
    );
    expect(db.skills.create).toHaveBeenCalledWith(expect.not.objectContaining({ isSystem: true }));
    expect(db.prompts.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'target' }));
  });

  it('exports visual fields without the portrait URL', async () => {
    const db = exportAdapters();
    vi.mocked(db.agents.find).mockResolvedValue([
      { ...agent, visual: { portraitUrl: 'https://temp.example/p.png', style: 'ink', generationPrompt: 'a fox' } },
    ] as never);
    const archive = await exportAgentConfiguration('source', db);

    expect(archive.agents[0].visual).toEqual({ style: 'ink', generationPrompt: 'a fox' });
  });

  it('does not pass an archived portrait URL to agent creation', async () => {
    const archive = await exportAgentConfiguration('source', exportAdapters());
    const withPortrait = {
      ...archive,
      agents: [
        {
          ...archive.agents[0],
          visual: { portraitUrl: 'https://temp.example/p.png', style: 'ink', generationPrompt: 'a fox' },
        },
      ],
    } as AgentConfigurationArchive;
    const db = importAdapters();
    await importAgentConfiguration('target', withPortrait, db);

    expect(db.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({ visual: { style: 'ink', generationPrompt: 'a fox' } })
    );
    expect(JSON.stringify(vi.mocked(db.agents.create).mock.calls)).not.toContain('temp.example');
  });

  it('leaves voice agents out of export and import', async () => {
    const db = exportAdapters();
    vi.mocked(db.agents.find).mockResolvedValue([agent, { ...agent, id: 'voice-agent', type: 'voice' }] as never);
    const archive = await exportAgentConfiguration('source', db);
    expect(archive.agents.map(row => row.id)).toEqual(['agent-old']);

    const importDb = importAdapters();
    const ids = await importAgentConfiguration(
      'target',
      {
        ...archive,
        agents: [...archive.agents, { ...agent, id: 'voice-agent', type: 'voice' }],
      } as AgentConfigurationArchive,
      importDb
    );
    expect(importDb.agents.create).toHaveBeenCalledTimes(1);
    expect(ids.agents.has('voice-agent')).toBe(false);
  });

  it('rejects a malformed archive before any write', async () => {
    const archive = await exportAgentConfiguration('source', exportAdapters());
    const malformed = [
      { ...archive, favorites: [{ documentId: 'x', documentType: 'bogus' }] },
      { ...archive, mcpServers: [{ name: 'not-a-server', envVariableKeys: [] }] },
      { ...archive, skills: [{ ...archive.skills[0], files: [{ path: '../etc/passwd', content: 'x' }] }] },
      { ...archive, agents: [{ ...archive.agents[0], temperature: 'hot' }] },
      { ...archive, agents: [{ ...archive.agents[0], allowedTools: 'bash' }] },
      { ...archive, projects: undefined },
    ];
    for (const bad of malformed) {
      const db = importAdapters();
      await expect(
        importAgentConfiguration('target', bad as unknown as AgentConfigurationArchive, db)
      ).rejects.toThrow();
      for (const writer of Object.values(db)) {
        expect(vi.mocked('create' in writer ? writer.create : writer.updatePreferences).mock.calls).toHaveLength(0);
      }
    }
  });

  it('reports what was created when a write fails partway', async () => {
    const archive = await exportAgentConfiguration('source', exportAdapters());
    const db = importAdapters();
    vi.mocked(db.skills.create).mockRejectedValue(new Error('db down'));

    const error = await importAgentConfiguration('target', archive, db).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentConfigurationImportError);
    const failure = error as AgentConfigurationImportError;
    expect(failure.created.projects.get('project-old')).toBe('project-new');
    expect(failure.created.agents.get('agent-old')).toBe('agent-new');
    expect(failure.created.skills.size).toBe(0);
    expect((failure.cause as Error).message).toBe('db down');
    expect(db.prompts.create).not.toHaveBeenCalled();
  });

  it('refuses to export when the account is missing', async () => {
    const db = exportAdapters();
    vi.mocked(db.users.findById).mockResolvedValue(null);

    await expect(exportAgentConfiguration('source', db)).rejects.toThrow('Account not found');
  });

  it('remaps session and file favorites through references and drops unmapped ones', async () => {
    const db = exportAdapters();
    vi.mocked(db.favorites.find).mockResolvedValue([
      { userId: 'source', documentId: 'session-old', documentType: 'sessions' },
      { userId: 'source', documentId: 'file-old', documentType: 'files' },
      { userId: 'source', documentId: 'session-unmapped', documentType: 'sessions' },
      { userId: 'source', documentId: 'file-unmapped', documentType: 'files' },
    ] as never);
    const archive = await exportAgentConfiguration('source', db);
    expect(archive.favorites).toHaveLength(4);

    const importDb = importAdapters();
    await importAgentConfiguration('target', archive, importDb, {
      sessions: new Map([['session-old', 'session-new']]),
      files: new Map([['file-old', 'file-new']]),
    });

    const calls = vi.mocked(importDb.favorites.create).mock.calls.map(([favorite]) => favorite);
    expect(calls).toEqual([
      { userId: 'target', documentId: 'session-new', documentType: 'sessions' },
      { userId: 'target', documentId: 'file-new', documentType: 'files' },
    ]);
  });

  it('round-trips identity, capabilities and skill files unchanged', async () => {
    const identity = {
      gender: 'other',
      pronouns: {
        subject: 'they',
        object: 'them',
        possessive: 'their',
        possessiveAdjective: 'theirs',
        reflexive: 'themself',
      },
    };
    const files = [
      { path: 'scripts/run.sh', content: 'echo hi' },
      { path: 'references/notes.md', content: 'notes' },
    ];
    const db = exportAdapters();
    vi.mocked(db.agents.find).mockResolvedValue([{ ...agent, identity, capabilities: ['research', 'code'] }] as never);
    vi.mocked(db.skills.find).mockResolvedValue([
      { id: 'skill-old', userId: 'source', name: 'Search', description: 'Look up', body: 'Search safely', files },
    ] as never);
    const archive = await exportAgentConfiguration('source', db);
    expect(archive.agents[0]).toMatchObject({ identity, capabilities: ['research', 'code'] });
    expect(archive.skills[0].files).toEqual(files);

    const importDb = importAdapters();
    await importAgentConfiguration('target', archive, importDb);
    expect(importDb.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({ identity, capabilities: ['research', 'code'] })
    );
    expect(importDb.skills.create).toHaveBeenCalledWith(expect.objectContaining({ files }));
  });

  it('round-trips push notification preferences', async () => {
    const pushNotifications = { enabled: true, categories: { mentions: false } };
    const db = exportAdapters();
    vi.mocked(db.users.findById).mockResolvedValue({ name: 'Owner', preferences: { pushNotifications } } as never);
    const archive = await exportAgentConfiguration('source', db);
    expect(archive.profile.preferences.pushNotifications).toEqual(pushNotifications);

    const importDb = importAdapters();
    await importAgentConfiguration('target', archive, importDb);
    expect(importDb.users.updatePreferences).toHaveBeenCalledWith('target', { pushNotifications });
  });

  it.each(['agents', 'skills', 'projects', 'prompts', 'mcpServers', 'sessionToolApprovals', 'favorites'] as const)(
    'rejects an occupied %s collection before writing anything',
    async collection => {
      const archive = await exportAgentConfiguration('source', exportAdapters());
      const db = importAdapters();
      vi.mocked(db[collection].findOne).mockResolvedValue({ id: 'existing' });

      await expect(importAgentConfiguration('target', archive, db)).rejects.toThrow('requires an empty account');
      for (const writer of Object.values(db)) {
        expect(vi.mocked('create' in writer ? writer.create : writer.updatePreferences).mock.calls).toHaveLength(0);
      }
      expect(db[collection].findOne).toHaveBeenCalledWith(expect.objectContaining({ userId: 'target' }));
    }
  );

  it('rejects a connected MCP server and same-named skill without shadowing either', async () => {
    const archive = await exportAgentConfiguration('source', exportAdapters());
    const db = importAdapters();
    vi.mocked(db.skills.findOne).mockResolvedValue({ name: 'Search', userId: 'target' });
    vi.mocked(db.mcpServers.findOne).mockResolvedValue({ name: 'github', userId: 'target', enabled: true });

    await expect(importAgentConfiguration('target', archive, db)).rejects.toThrow('requires an empty account');
    expect(db.projects.create).not.toHaveBeenCalled();
    expect(db.mcpServers.create).not.toHaveBeenCalled();
  });

  it('merges only defined preferences and preserves the target display name', async () => {
    const archive = await exportAgentConfiguration('source', exportAdapters());
    const db = importAdapters();
    await importAgentConfiguration('target', archive, db);

    expect(db.users.updatePreferences).toHaveBeenCalledWith('target', { agentModeDefault: 'auto' });
    expect(JSON.stringify(vi.mocked(db.users.updatePreferences).mock.calls)).not.toContain('name');
  });
});
