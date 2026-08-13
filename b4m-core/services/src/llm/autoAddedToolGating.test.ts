import { describe, it, expect } from 'vitest';
import {
  BLOG_REQUEST_PATTERN,
  hasPriorToolUse,
  shouldOfferBlogTools,
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
