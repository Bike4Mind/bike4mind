import { assistantReplyRemarkPlugins } from '@client/app/utils/remarkPlugins';
import { createBlockParser, splitStreamingBlocks } from './streamingSplit';

export const replyParser = createBlockParser(assistantReplyRemarkPlugins);

/** The settled blocks joined back together, and the live tail. */
export const splitStreamingMarkdown = (text: string) => {
  const { committed, tail } = splitStreamingBlocks(text, replyParser);
  return { committed, tail };
};
