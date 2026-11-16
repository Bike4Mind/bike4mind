import { describe, expect, it } from 'vitest';
import type { IAgent, ISkill, IBriefcasePrompt, IImageGenerationTemplate } from '@bike4mind/common';
import {
  agentLibraryDefinition,
  skillLibraryDefinition,
  promptLibraryDefinition,
  templateLibraryDefinition,
} from './libraryDefinition';

describe('organization library definitions', () => {
  it('copies agent instructions without personal ownership, dependencies or runtime state', () => {
    const source = {
      name: 'Helper',
      description: 'Help',
      systemPrompt: 'Be helpful',
      userId: 'author',
      organizationId: 'other-org',
      projectId: 'private-project',
      currentCredits: 100,
      useOwnCredits: true,
      memoryJournal: [{ content: 'private memory' }],
      tavernSessionId: 'private-session',
      exclusiveMcpServers: ['private-server'],
      defaultVariables: { secret: 'private' },
      visual: { portraitUrl: 'private-file' },
      users: [{ userId: 'other' }],
      heartbeatConfig: { enabled: true },
    } as unknown as IAgent;
    const { definition } = agentLibraryDefinition(source);
    expect(definition).toMatchObject({
      name: 'Helper',
      systemPrompt: 'Be helpful',
      useOwnCredits: false,
      isPublic: false,
    });
    for (const key of [
      'userId',
      'organizationId',
      'projectId',
      'currentCredits',
      'memoryJournal',
      'tavernSessionId',
      'exclusiveMcpServers',
      'defaultVariables',
      'visual',
      'users',
      'heartbeatConfig',
    ]) {
      expect(definition).not.toHaveProperty(key);
    }
  });

  it('rejects voice agents', () => {
    expect(() => agentLibraryDefinition({ type: 'voice' } as IAgent)).toThrow('Voice agents');
  });

  it('copies skill content without author grants or marketplace identity', () => {
    const snapshot = skillLibraryDefinition({
      name: 'helper',
      description: 'Help',
      body: 'Instructions',
      userId: 'author',
      importedFrom: { listingId: 'listing' },
      isGlobalWrite: true,
    } as unknown as ISkill);
    expect(snapshot.definition).toMatchObject({ name: 'helper', body: 'Instructions' });
    expect(snapshot.definition).not.toHaveProperty('userId');
    expect(snapshot.definition).not.toHaveProperty('isGlobalWrite');
    expect(snapshot.definition).not.toHaveProperty('importedFrom');
  });

  it('copies prompt templates without changing system-wide visibility', () => {
    const snapshot = promptLibraryDefinition({
      name: 'Writing',
      type: 'writing',
      promptText: 'Write {{userName}}',
      userId: 'author',
      visibilityScopes: ['private'],
    } as IBriefcasePrompt);
    expect(snapshot.definition).toMatchObject({ promptText: 'Write {{userName}}' });
    expect(snapshot.definition).not.toHaveProperty('userId');
    expect(snapshot.definition).not.toHaveProperty('visibilityScopes');
  });

  it('copies image settings without personal ownership or usage state', () => {
    const snapshot = templateLibraryDefinition({
      name: 'Portrait',
      userId: 'author',
      model: 'flux-pro-1.1',
      settings: {},
      usageCount: 10,
    } as IImageGenerationTemplate);
    expect(snapshot.definition).toMatchObject({ name: 'Portrait', settings: {} });
    expect(snapshot.definition).not.toHaveProperty('userId');
    expect(snapshot.definition).not.toHaveProperty('usageCount');
  });
});
