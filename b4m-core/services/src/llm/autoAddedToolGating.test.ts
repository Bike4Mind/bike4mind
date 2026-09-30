import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKE_TOOL_NAMES } from '@bike4mind/common';
import { ServerAgentStore } from './agents/ServerAgentStore';
import {
  BLOG_REQUEST_PATTERN,
  hasPriorToolUse,
  mentionsDataLakeSave,
  mentionsDelegatableAgent,
  shouldOfferDataLakeTools,
  shouldOfferBlogTools,
  shouldOfferDelegation,
  shouldOfferSkillTool,
} from './autoAddedToolGating';

describe('BLOG_REQUEST_PATTERN', () => {
  // Pinned verbatim for every ContentPublishingModal.tsx OutputFormat, not just 'blog' - a
  // human review caught that the first version of this pattern missed linkedin/twitter/newsletter
  // (currently disabled "Coming Soon" radios in the client, but the server-side blog_draft schema
  // already accepts all four). If this stops matching any of them, the Studio silently loses
  // blog_draft the moment the client enables that format.
  it.each(['blog', 'linkedin', 'twitter', 'newsletter'])(
    'matches the Content Publishing Studio prompt for outputFormat=%s',
    format => {
      expect(BLOG_REQUEST_PATTERN.test(`Transform this conversation into a ${format} post.`)).toBe(true);
    }
  );

  it.each(['post this to slack', 'publish the artifact', 'what is a weblog', ''])('does not fire on %j', message => {
    expect(BLOG_REQUEST_PATTERN.test(message)).toBe(false);
  });

  it.each(['blog', 'blogs', 'blogging', 'blogged', 'blogpost', 'substack', 'wordpress', 'ghost cms'])(
    'fires on %j',
    word => {
      expect(BLOG_REQUEST_PATTERN.test(`please ${word} this`)).toBe(true);
    }
  );
});

describe('hasPriorToolUse', () => {
  it('finds a matching name in the prior-tool-names list', () => {
    expect(hasPriorToolUse(['blog_draft'], ['blog_draft', 'blog_publish'])).toBe(true);
  });

  it('does not match a tool name outside the given list', () => {
    expect(hasPriorToolUse(['skill'], ['blog_draft', 'blog_publish', 'blog_edit'])).toBe(false);
  });

  it('returns false for an empty prior-tool-names list', () => {
    expect(hasPriorToolUse([], ['blog_draft'])).toBe(false);
  });
});

describe('shouldOfferBlogTools', () => {
  const base = { isAdmin: true, hasBlogIntegration: true, message: 'Hello', priorToolNames: [] as string[] };

  it('offers nothing for a non-admin, even with blog intent', () => {
    expect(shouldOfferBlogTools({ ...base, isAdmin: false, message: 'blog this conversation' })).toEqual({
      draft: false,
      publish: false,
      edit: false,
    });
  });

  it('offers only draft for an admin without blog integration, with blog intent', () => {
    expect(shouldOfferBlogTools({ ...base, hasBlogIntegration: false, message: 'blog this' })).toEqual({
      draft: true,
      publish: false,
      edit: false,
    });
  });

  it('offers all three for an integrated admin, with blog intent', () => {
    expect(shouldOfferBlogTools({ ...base, message: 'blog this conversation' })).toEqual({
      draft: true,
      publish: true,
      edit: true,
    });
  });

  it('offers nothing for an ordinary message with no prior blog tool use', () => {
    expect(shouldOfferBlogTools(base)).toEqual({ draft: false, publish: false, edit: false });
  });

  it('empty message does not throw and offers nothing', () => {
    expect(shouldOfferBlogTools({ ...base, message: '' })).toEqual({ draft: false, publish: false, edit: false });
  });

  // The multi-turn continuation rescue: a follow-up with no blog keyword still gets the tools
  // when an earlier turn already used one, so a "write a blog post" -> "now publish it" workflow
  // does not silently lose blog_publish mid-conversation. priorToolNames is read straight off
  // promptMeta.functionCalls (see fetchAndProcessPreviousMessages) - not derived from message
  // content, which is why this test passes a plain name list rather than a fake IMessage shape.
  it('offers all three on a follow-up turn that used blog_draft earlier, even with no blog keyword', () => {
    expect(shouldOfferBlogTools({ ...base, message: 'now publish it', priorToolNames: ['blog_draft'] })).toEqual({
      draft: true,
      publish: true,
      edit: true,
    });
  });
});

describe('shouldOfferSkillTool', () => {
  const base = {
    hasSkillRepository: true,
    invocableSkillCount: 0,
    message: 'Hello',
    priorToolNames: [] as string[],
  };

  it('never offers it when the host has no skill repository, whatever else is true', () => {
    expect(shouldOfferSkillTool({ ...base, hasSkillRepository: false, invocableSkillCount: 5 })).toBe(false);
  });

  it('offers it when the user has at least one invocable skill', () => {
    expect(shouldOfferSkillTool({ ...base, invocableSkillCount: 1 })).toBe(true);
  });

  it('does not offer it for an empty catalog and no invocation attempt', () => {
    expect(shouldOfferSkillTool(base)).toBe(false);
  });

  it('rescues an empty catalog via an explicit /skill-name invocation attempt', () => {
    expect(shouldOfferSkillTool({ ...base, message: '/summarize the thread please' })).toBe(true);
  });

  // detectSkillMentions' name regex is lowercase-only; normalizing the message before the check
  // means a case-mismatched attempt still gets the tool offered, even though SkillsFeature itself
  // will not resolve the mismatched name.
  it('rescues an empty catalog even when the slash command is uppercase', () => {
    expect(shouldOfferSkillTool({ ...base, message: '/Summarize the thread' })).toBe(true);
  });

  it('rescues an empty catalog via a prior skill invocation this conversation', () => {
    expect(shouldOfferSkillTool({ ...base, message: 'and now?', priorToolNames: ['skill'] })).toBe(true);
  });

  it('empty message does not throw', () => {
    expect(shouldOfferSkillTool({ ...base, message: '' })).toBe(false);
  });
});

// Derived from the real store rather than a hand-copied list: these are exactly the names
// ChatCompletionProcess feeds the gate (it constructs ServerAgentStore with no user/org overlays),
// and exactly the values `delegate_to_agent`'s `agent` enum can hold. Renaming a built-in fails
// these tests instead of quietly making them assert against a set that no longer exists.
const STORE_AGENTS = new ServerAgentStore({}).getAgentNames();

describe('mentionsDelegatableAgent', () => {
  // Names the cases below type as @mentions. Asserted up front so a built-in rename reports
  // "researcher is gone" rather than a pile of confusing false-vs-true failures downstream.
  it('pins the built-in names these cases rely on', () => {
    expect(STORE_AGENTS).toEqual(expect.arrayContaining(['researcher', 'code_review', 'analyst']));
  });

  it.each(['@researcher find the specs', 'hey @code_review take a look', 'ping @analyst on this'])(
    'fires on a mention naming a store agent: %j',
    message => {
      expect(mentionsDelegatableAgent(message, STORE_AGENTS)).toBe(true);
    }
  );

  // The store spells its multi-word names with underscores; the mention parser accepts hyphens.
  // Without normalization `@code-review` would silently lose delegation.
  it('accepts the hyphenated spelling of an underscored store name', () => {
    expect(mentionsDelegatableAgent('@code-review please', STORE_AGENTS)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(mentionsDelegatableAgent('@Researcher look this up', STORE_AGENTS)).toBe(true);
  });

  // The regression this narrowing exists for: ordinary prose containing an @handle used to attach
  // the delegate_to_agent schema (~786 tokens) plus the tool prompt's agent directory.
  it.each([
    'can you loop in @dave on this thread',
    'follow @anthropicai for updates',
    '@here does anyone know the answer',
    'my address is nao@bike4mind.com',
    'the researcher agent could help here',
    '',
  ])('does not fire on %j', message => {
    expect(mentionsDelegatableAgent(message, STORE_AGENTS)).toBe(false);
  });

  // A persona agent from the `agents` collection is applied as a system prompt by
  // AgentDetectionFeature; it is never a value delegate_to_agent's `agent` enum can take.
  it('does not fire on a persona mention that the delegation store cannot run', () => {
    expect(mentionsDelegatableAgent('@coffee-bot what should I order', STORE_AGENTS)).toBe(false);
  });

  it('does not fire when the store is empty', () => {
    expect(mentionsDelegatableAgent('@researcher find the specs', [])).toBe(false);
  });
});

describe('shouldOfferDelegation', () => {
  const base = {
    disableUserIntegrations: false,
    allowedAgents: undefined,
    sessionAgentIds: undefined,
    message: 'compare the latest smartphones',
    delegatableAgentNames: STORE_AGENTS,
  };

  it('withholds delegation from a benign prompt with no signal', () => {
    expect(shouldOfferDelegation(base)).toBe(false);
  });

  it('offers delegation for a mention naming a store agent', () => {
    expect(shouldOfferDelegation({ ...base, message: '@researcher compare the latest smartphones' })).toBe(true);
  });

  it('withholds delegation for a mention that names nothing the store can run', () => {
    expect(shouldOfferDelegation({ ...base, message: '@dave compare the latest smartphones' })).toBe(false);
  });

  it('offers delegation when the caller passes an allowedAgents allowlist', () => {
    expect(shouldOfferDelegation({ ...base, allowedAgents: ['researcher'] })).toBe(true);
  });

  // An empty allowlist means "no delegation requested", not "delegation requested with no targets" -
  // the latter would expose the tool to the model and give it nothing valid to call.
  it('treats an empty allowedAgents allowlist as no delegation requested', () => {
    expect(shouldOfferDelegation({ ...base, allowedAgents: [] })).toBe(false);
  });

  it('offers delegation when an agent is attached to the session', () => {
    expect(shouldOfferDelegation({ ...base, sessionAgentIds: ['agent-id'] })).toBe(true);
  });

  // Pins the deliberate asymmetry with the blog/skill gates, which DO rescue on a prior call.
  // Re-arming autonomous subagent spawning for a whole conversation off one earlier delegation is
  // the expensive failure mode this gate exists to prevent; a genuine multi-turn workflow is
  // carried by session.agentIds instead. If someone adds a rescue here, this test should be the
  // conversation, not a silent green.
  it('does not re-offer delegation on a later turn just because an earlier turn delegated', () => {
    expect(shouldOfferDelegation({ ...base, message: 'now check battery life too' })).toBe(false);
  });

  // disableUserIntegrations is a hard veto: a curated surface must never delegate, whatever the
  // other signals say.
  it.each([
    ['an allowlist', { allowedAgents: ['researcher'] }],
    ['a session agent', { sessionAgentIds: ['agent-id'] }],
    ['a store-agent mention', { message: '@researcher help' }],
  ])('vetoes delegation on a disableUserIntegrations surface despite %s', (_label, override) => {
    expect(shouldOfferDelegation({ ...base, ...override, disableUserIntegrations: true })).toBe(false);
  });
});

describe('mentionsDataLakeSave', () => {
  it.each([
    'Save this summary to my data lake',
    'can you add it to the Data-Lake?',
    'what data lakes do I have',
    'Store these notes into my research lake',
    'add these notes to my Research lake',
    'upload the table to the lake',
    'SAVE THIS TO MY LAKE',
    'Put that into a new lake called Q3',
    'put that in a lake',
    'create a lake called Q3',
    'Make me a new research lake',
    'list my lakes',
    'Show me all of our lakes',
    'what lakes do I have',
    'Which lakes can I save to?',
  ])('fires on %j', message => {
    expect(mentionsDataLakeSave(message)).toBe(true);
  });

  it.each([
    'Planning a Lake Tahoe trip next month',
    'Lake Michigan weather this weekend',
    'save the photos from our trip to Lake Tahoe',
    'I love lakes',
    'save the file',
    'we lakers',
    'the lakers won last night',
    'drive to the lake',
    'add a stop at the lake on the way home',
    'save this as a PDF',
    'save me a seat',
  ])('stays quiet on %j', message => {
    expect(mentionsDataLakeSave(message)).toBe(false);
  });
});

describe('shouldOfferDataLakeTools', () => {
  const enabled = () => Promise.resolve(true);

  it('offers on intent when data lakes are enabled', async () => {
    await expect(
      shouldOfferDataLakeTools({ message: 'save this to my data lake', priorToolNames: [], dataLakesEnabled: enabled })
    ).resolves.toBe(true);
  });

  it('keeps offering on a follow-up once a data-lake tool was used', async () => {
    await expect(
      shouldOfferDataLakeTools({
        message: 'yes, the first one',
        priorToolNames: ['list_my_data_lakes'],
        dataLakesEnabled: enabled,
      })
    ).resolves.toBe(true);
  });

  it('never offers when the platform has data lakes disabled', async () => {
    await expect(
      shouldOfferDataLakeTools({
        message: 'save this to my data lake',
        priorToolNames: [],
        dataLakesEnabled: () => Promise.resolve(false),
      })
    ).resolves.toBe(false);
  });

  it('skips the settings read entirely on a turn with no intent', async () => {
    const dataLakesEnabled = vi.fn(enabled);
    await expect(
      shouldOfferDataLakeTools({ message: 'what is the weather', priorToolNames: ['web_search'], dataLakesEnabled })
    ).resolves.toBe(false);
    expect(dataLakesEnabled).not.toHaveBeenCalled();
  });

  it('names exactly the three save-to-data-lake tools', () => {
    expect([...DATA_LAKE_TOOL_NAMES].sort()).toEqual(
      ['create_data_lake', 'list_my_data_lakes', 'save_content_to_data_lake'].sort()
    );
  });
});
