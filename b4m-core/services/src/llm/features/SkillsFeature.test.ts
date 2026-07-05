import { describe, it, expect, vi } from 'vitest';
import { SkillsFeature } from './SkillsFeature';
import type { ChatCompletionContext } from '../ChatCompletionFeatures';
import type { ISkill } from '@bike4mind/common';

type SkillsFinder = {
  /** Batched accessible-scope name lookup - single `$in` query. */
  findAccessibleByNamesForUser?: ReturnType<typeof vi.fn>;
  /** Accessible-scope catalog cap pushed into Mongo via `limit + sort`. */
  listAccessibleInvocableForUser?: ReturnType<typeof vi.fn>;
};

function makeContext(skills?: SkillsFinder | null): ChatCompletionContext {
  return {
    user: { id: 'user-1' },
    logger: { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db: {
      skills: skills ?? undefined,
    },
  } as unknown as ChatCompletionContext;
}

function makeSkill(overrides: Partial<ISkill>): ISkill {
  return {
    id: 's1',
    name: 'summarize',
    description: 'Summarize text',
    body: 'Summarize: $ARGUMENTS',
    userId: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ISkill;
}

function makeQuest(): Record<string, unknown> {
  return { id: 'q1' };
}

const baseArgs = {
  session: { id: 's1' } as never,
  startParams: undefined,
  llm: undefined,
  model: 'claude-sonnet',
  historyCount: 0,
  fabFileIds: [],
  questId: 'q1',
  questMaster: undefined,
};

describe('SkillsFeature', () => {
  it('returns no system messages when the message has no /skill mentions', async () => {
    const feature = new SkillsFeature(
      makeContext({
        findAccessibleByNamesForUser: vi.fn().mockResolvedValue([]),
        listAccessibleInvocableForUser: vi.fn().mockResolvedValue([]),
      })
    );
    const quest = makeQuest();

    await feature.beforeDataGathering({ ...baseArgs, quest: quest as never, message: 'hello world' });
    const messages = await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never);

    expect(messages).toEqual([]);
  });

  it('skips silently when the skill repository is not wired', async () => {
    const feature = new SkillsFeature(makeContext(null));
    const quest = makeQuest();

    const result = await feature.beforeDataGathering({
      ...baseArgs,
      quest: quest as never,
      message: '/summarize hello',
    });

    expect(result.shouldContinue).toBe(true);
    expect(await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never)).toEqual([]);
  });

  it('injects an expanded skill body when a mention resolves', async () => {
    const findAccessibleByNamesForUser = vi
      .fn()
      .mockResolvedValue([makeSkill({ name: 'summarize', body: 'Summarize: $ARGUMENTS' })]);
    const listAccessibleInvocableForUser = vi.fn().mockResolvedValue([]);
    const feature = new SkillsFeature(makeContext({ findAccessibleByNamesForUser, listAccessibleInvocableForUser }));
    const quest = makeQuest();

    await feature.beforeDataGathering({
      ...baseArgs,
      quest: quest as never,
      message: '/summarize the user input',
    });
    const messages = await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never);

    // Batched: ONE call for the whole mention list, not one per mention.
    expect(findAccessibleByNamesForUser).toHaveBeenCalledTimes(1);
    expect(findAccessibleByNamesForUser).toHaveBeenCalledWith('user-1', ['summarize']);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Skill Invoked: /summarize');
    expect(messages[0]?.content).toContain('Summarize: the user input');
  });

  it('injects one system message per resolved skill in mention order, batched as a single query', async () => {
    const skills = [
      makeSkill({ name: 'summarize', body: 'Summarize: $ARGUMENTS' }),
      makeSkill({ name: 'translate', body: 'Translate: $ARGUMENTS' }),
    ];
    const findAccessibleByNamesForUser = vi.fn().mockResolvedValue(skills);
    const listAccessibleInvocableForUser = vi.fn().mockResolvedValue([]);
    const feature = new SkillsFeature(makeContext({ findAccessibleByNamesForUser, listAccessibleInvocableForUser }));
    const quest = makeQuest();

    await feature.beforeDataGathering({
      ...baseArgs,
      quest: quest as never,
      message: '/summarize hello world /translate english to french',
    });
    const messages = await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never);

    // ONE round-trip for both mentions - N+1 guarded.
    expect(findAccessibleByNamesForUser).toHaveBeenCalledTimes(1);
    expect(findAccessibleByNamesForUser).toHaveBeenCalledWith('user-1', ['summarize', 'translate']);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain('Summarize: hello world');
    expect(messages[1]?.content).toContain('Translate: english to french');
  });

  it('injects an "Available Skills" catalog using listAccessibleInvocableForUser (limit pushed to Mongo)', async () => {
    const listAccessibleInvocableForUser = vi
      .fn()
      .mockResolvedValue([
        makeSkill({ name: 'summarize', description: 'Summarize text', argumentHint: '<text>' }),
        makeSkill({ name: 'translate', description: 'Translate text' }),
      ]);
    const feature = new SkillsFeature(
      makeContext({ findAccessibleByNamesForUser: vi.fn().mockResolvedValue([]), listAccessibleInvocableForUser })
    );
    const quest = makeQuest();

    await feature.beforeDataGathering({ ...baseArgs, quest: quest as never, message: 'just a chat message' });
    const messages = await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never);

    // Cap is pushed into Mongo - limit is passed as the second arg.
    expect(listAccessibleInvocableForUser).toHaveBeenCalledWith('user-1', 50);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain('Available Skills');
    expect(messages[0]?.content).toContain('/summarize <text>');
    expect(messages[0]?.content).toContain('/translate');
  });

  it('sanitizes catalog descriptions — strips backticks and collapses newlines', async () => {
    const listAccessibleInvocableForUser = vi.fn().mockResolvedValue([
      makeSkill({
        name: 'attack',
        description: 'Description with `backticks` and\n## injected\n## headings',
      }),
    ]);
    const feature = new SkillsFeature(
      makeContext({ findAccessibleByNamesForUser: vi.fn().mockResolvedValue([]), listAccessibleInvocableForUser })
    );
    const quest = makeQuest();

    await feature.beforeDataGathering({ ...baseArgs, quest: quest as never, message: 'hi' });
    const messages = await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never);

    const content = messages[0]?.content ?? '';
    // The fenced skill-name span uses backticks; the description must not be
    // able to close that span and escape into prompt-instruction context.
    expect(content).not.toContain('`backticks`');
    // Newlines collapsed - description occupies a single line in the catalog.
    expect(content.split('\n').filter(line => line.includes('attack'))).toHaveLength(1);
  });

  it('drops mentions that do not resolve to a skill the user can access', async () => {
    const findAccessibleByNamesForUser = vi.fn().mockResolvedValue([]);
    const listAccessibleInvocableForUser = vi.fn().mockResolvedValue([]);
    const feature = new SkillsFeature(makeContext({ findAccessibleByNamesForUser, listAccessibleInvocableForUser }));
    const quest = makeQuest();

    await feature.beforeDataGathering({ ...baseArgs, quest: quest as never, message: '/unknown skill' });
    const messages = await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never);

    expect(messages).toEqual([]);
  });

  it('wraps a non-owner (shared) skill body as untrusted content', async () => {
    const findAccessibleByNamesForUser = vi
      .fn()
      .mockResolvedValue([makeSkill({ name: 'shared', body: 'Do the thing: $ARGUMENTS', userId: 'other-user' })]);
    const listAccessibleInvocableForUser = vi.fn().mockResolvedValue([]);
    const feature = new SkillsFeature(makeContext({ findAccessibleByNamesForUser, listAccessibleInvocableForUser }));
    const quest = makeQuest();

    await feature.beforeDataGathering({ ...baseArgs, quest: quest as never, message: '/shared now' });
    const messages = await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never);

    expect(messages).toHaveLength(1);
    const content = messages[0]?.content ?? '';
    // Untrusted framing + delimiters present; body still expanded.
    expect(content).toContain('untrusted');
    expect(content).toContain('UNTRUSTED_SKILL_CONTENT');
    expect(content).toContain('Do the thing: now');
    // The plain owner-trusted heading must NOT be used for a shared skill.
    expect(content).not.toContain('## Skill Invoked: /shared\n');
  });

  it('keeps an owner-authored skill body as trusted (no untrusted wrapping)', async () => {
    const findAccessibleByNamesForUser = vi
      .fn()
      .mockResolvedValue([makeSkill({ name: 'mine', body: 'Summarize: $ARGUMENTS', userId: 'user-1' })]);
    const listAccessibleInvocableForUser = vi.fn().mockResolvedValue([]);
    const feature = new SkillsFeature(makeContext({ findAccessibleByNamesForUser, listAccessibleInvocableForUser }));
    const quest = makeQuest();

    await feature.beforeDataGathering({ ...baseArgs, quest: quest as never, message: '/mine hello' });
    const messages = await feature.getContextMessages(quest as never, undefined as never, '', 0, undefined as never);

    const content = messages[0]?.content ?? '';
    expect(content).toContain('## Skill Invoked: /mine');
    expect(content).not.toContain('UNTRUSTED_SKILL_CONTENT');
  });
});
