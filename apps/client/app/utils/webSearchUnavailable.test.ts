import { describe, it, expect } from 'vitest';
import { replyReportsNoWebSearch } from './webSearchUnavailable';

const RIGHT_QUOTE = String.fromCharCode(0x2019);

describe('replyReportsNoWebSearch', () => {
  it.each([
    'I tried, but no search tool is connected in this chat.',
    "I don't have access to web search right now, so I can't cite URLs.",
    `I don${RIGHT_QUOTE}t have internet access in this conversation.`,
    'I cannot browse the web, but here is what I know.',
    "I'm unable to access the internet for live results.",
    'Web search is not enabled for this conversation.',
    `I do not have real-time data about today${RIGHT_QUOTE}s headlines.`,
  ])('matches %j', reply => {
    expect(replyReportsNoWebSearch(reply)).toBe(true);
  });

  it.each([
    'Here are the top AI headlines today, with sources.',
    'You can search the web for more examples.',
    'The internet was invented in the 1960s.',
    "I don't have a strong opinion on web frameworks.",
  ])('ignores %j', reply => {
    expect(replyReportsNoWebSearch(reply)).toBe(false);
  });
});
