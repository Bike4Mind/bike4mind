import { handleLLMCommand } from '@client/app/components/commands/LLMCommand';
import { handleModelsCommand } from '@client/app/components/commands/ModelsCommand';
import { handleRollCommand } from '@client/app/components/commands/RollCommand';
import { handleSetKeyCommand } from '@client/app/components/commands/SetKeyCommand';
import {
  handleImageEditCommand,
  handleImageGenerationCommand,
} from '@client/app/components/commands/ImageGenerationCommand';
import { handleVideoGenerationCommand } from '@client/app/components/commands/VideoGenerationCommand';
import { handleCreateAgentCommand } from '@client/app/components/commands/CreateAgentCommand';
import { CommandHandlers } from '@client/app/utils/commands';

export const fixedIconSize = {
  width: '32px !important',
  height: '32px !important',
  minWidth: '32px !important',
  minHeight: '32px !important',
  maxWidth: '32px !important',
  maxHeight: '32px !important',
};

export const commandHandlers: CommandHandlers = {
  '/llm': handleLLMCommand,
  '/roll': handleRollCommand,
  '/models': handleModelsCommand,
  '/key': handleSetKeyCommand,
  '/gen_image': handleImageGenerationCommand,
  '/gen_video': handleVideoGenerationCommand,
  '/edit_image': handleImageEditCommand,
  '/create_agent': handleCreateAgentCommand,
};
