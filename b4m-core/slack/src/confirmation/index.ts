/**
 * Confirmation flow utilities for Slack MCP operations (Block Kit button flow).
 *
 * The flow:
 * 1. MCP tool returns _confirmToken
 * 2. ChatCompletionProcess saves it to Quest.pendingAction
 * 3. events.ts looks up Quest, passes questId to buildConfirmationButtons
 * 4. Button click triggers interactive.ts which looks up Quest by ID
 */

export {
  buildConfirmationButtons,
  buildAttachmentDownloadButtons,
  formatPreviewFromParams,
  type SlackBlockKitButton,
  type SlackBlockKitActions,
  type SlackBlockKitDivider,
  type SlackBlockKitSection,
  type SlackBlockKitContext,
  type SlackBlockKitElement,
  type AttachmentDownloadInfo,
} from './confirmation-buttons';

export { buildImageModelPicker, getImageModelDisplayName, IMAGE_GEN_MODEL_ACTION_ID } from './image-model-picker';
