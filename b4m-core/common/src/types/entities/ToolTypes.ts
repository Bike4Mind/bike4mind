import { ChatModels } from '../../models';
import { IFabFileDocument } from './FabFileTypes';
import { IShareableDocument } from './ShareableDocumentTypes';

export type LLMParams = {
  model: string;
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[] | null;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: { [key: string]: number } | null;
};

// Defaults for optional LLM Params
export const DefaultLLMParams: LLMParams = {
  model: ChatModels.GPT4o_MINI,
  temperature: 0.9,
  top_p: 1,
  n: 1,
  stream: true,
  stop: null,
  max_tokens: 3999,
  presence_penalty: 0,
  frequency_penalty: 0,
  logit_bias: null,
};

export interface ITool {
  name: string;
  userId: string;
  workBenchFiles: IFabFileDocument[];
  llmParams: LLMParams;
}

export interface IToolDocument extends ITool, IShareableDocument {}
