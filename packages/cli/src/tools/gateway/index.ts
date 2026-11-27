export { wrapToolWithPermission, wrapTools } from './gateway.js';
export type {
  AgentContext,
  PermissionPromptKind,
  PermissionPromptOptions,
  ShowPermissionPrompt,
  ToolArgs,
  WrapToolDeps,
} from './gatewayTypes.js';
export type { ToolCategory, ToolDescriptor, ToolEffect, ToolSource } from './toolDescriptor.js';
export { CORE_TOOL_DESCRIPTORS } from './coreToolDescriptors.js';
export { ToolCatalog, resolveStaticToolDescriptor } from './toolCatalog.js';
export {
  toolCategory,
  canTrustTool,
  isReadOnlyTool,
  commandTextOf,
  writePathOf,
  sandboxedCommandArg,
} from './toolPolicy.js';
