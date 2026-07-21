/**
 * Lightweight registry of contextual mini-help strings used by
 * `FieldTooltip` across the app. Keep entries short - one or two
 * sentences. For deeper documentation, link out via `ContextHelpButton`.
 */
export const FIELD_TOOLTIPS = {
  credits: 'AI operations consume credits. Your balance updates after each request.',
  burnRate:
    'Average credits consumed per day over your recent activity. Use this to estimate how long your balance will last.',
  temperature: 'Controls randomness: lower values are more deterministic, higher values are more creative.',
  fixedTemperature: 'This model only supports temperature 1.0.',
  maxTokensInput:
    'Tokens reserved for your prompt and conversation history. Increasing this leaves fewer tokens for the response.',
  maxTokensOutput:
    'Maximum tokens the model can generate in a single response. Higher values allow longer answers but cost more credits.',
  responseHistory: 'How many recent messages from this conversation are sent back to the model as context.',
  spokenWords: 'Approximate length the model targets for voice replies, in spoken words.',
  modelPicker:
    'Pick which AI model handles this request. Different models have different speeds, costs, and capabilities.',
  researchMode:
    'Enables multi-step research with source citations. Sends your prompt to several model configurations in parallel — uses more credits.',
  researchModeToggle:
    'Run the same prompt against up to four model/parameter configurations side-by-side. Token usage scales with the number of configurations.',
  imageModelTemperature:
    'Controls how loosely the image model interprets your prompt. Higher values yield more varied results.',
  imageSize:
    'Output resolution. Larger sizes capture more detail but cost more credits and take longer. Available sizes depend on the model.',
  imageQuality:
    'How much rendering effort to spend. Higher quality means more detail and higher cost. Tiers depend on the model (e.g. low / medium / high, or standard / hd).',
  aspectRatio:
    'The shape of the image: 16:9 is wide/landscape, 3:4 is tall/portrait, 1:1 is square. Supported on some models only.',
  imageSeed:
    'A number that makes a result reproducible: the same seed with the same prompt and settings regenerates the same image. Leave empty for a random result each time.',
  safetyTolerance:
    'How permissive content moderation is (Flux only). Lower is stricter, higher is more permissive (hard-capped).',
  promptEnhancement:
    'Prompt enhancement (Flux only): the model rewrites and expands your prompt before generating, often adding detail. Turn off to use your prompt exactly as written.',
} as const;

export type FieldTooltipKey = keyof typeof FIELD_TOOLTIPS;
