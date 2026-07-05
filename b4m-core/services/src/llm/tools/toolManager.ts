import { b4mLLMTools } from '@bike4mind/common';
import { z } from 'zod';

type BuiltInTool = z.infer<typeof b4mLLMTools>;
type ToolUnion = BuiltInTool | string;

const BUILT_IN_TOOL_SET = new Set<BuiltInTool>(b4mLLMTools.options);

export const filterBuiltInTools = (tools: ToolUnion[] | undefined): BuiltInTool[] => {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.filter((tool): tool is BuiltInTool => BUILT_IN_TOOL_SET.has(tool as BuiltInTool));
};

export const hasEnabledTools = (tools: ToolUnion[] | undefined): boolean => {
  return Array.isArray(tools) && tools.length > 0;
};

export const ToolManager = {
  filterBuiltInTools,
  hasEnabledTools,
};
