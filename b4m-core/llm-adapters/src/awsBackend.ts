import { IMessage, ModelBackend, ModelInfo, SpeechToTextModels } from '@bike4mind/common';
import { CompletionInfo, ICompletionBackend, ICompletionOptions } from './backend';

export class AWSBackend implements ICompletionBackend {
  public currentModel: string = '';

  constructor() {
    // AWS backend uses AWS credentials from environment, not API keys
  }

  async complete(
    model: string,
    messages: IMessage[],
    options?: Partial<ICompletionOptions>,
    onUpdate?: (texts: (string | null | undefined)[], info: CompletionInfo) => Promise<void>
  ): Promise<void> {
    this.currentModel = model;
    throw new Error('AWSBackend does not support text completion, only speech-to-text transcription');
  }

  pushToolMessages(_messages: IMessage[], _tool: { name: string; id: string; parameters: string }, _result: string) {
    throw new Error('AWSBackend does not support tool messages');
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return [
      {
        id: SpeechToTextModels.AWS_TRANSCRIBE,
        type: 'speech-to-text',
        name: 'Amazon Transcribe',
        backend: ModelBackend.AWS,
        contextWindow: 0, // Not applicable for speech-to-text
        supportsImageVariation: false,
        max_tokens: 0, // Not applicable for speech-to-text
        pricing: {
          1: { input: 2.4, output: 0 }, // $0.024 per minute of audio
        },
        description:
          'Amazon Transcribe - Automatic speech recognition service that converts audio to text with support for multiple languages and formats.',
        rank: 1,
      },
    ];
  }
}
