import type { B4MLLMTools } from '@bike4mind/common';

/** The production tools the Direct button requires; the launch narrows the agent to exactly these. */
export const DIRECTOR_TOOLS: readonly B4MLLMTools[] = [
  'production_storyboard',
  'production_generate_shot',
  'production_add_audio',
  'production_assemble',
];

export const buildDirectorSystemContext = (compositionId: string): string =>
  `You are directing the Studio production ${compositionId}. Use the production tools in order: ` +
  'production_storyboard (about 4 shots for a 15-30 second ad, each with an image prompt, a length and a voiceover line; ' +
  'pass the product photo as productFileId), ' +
  'production_generate_shot (call it again with the same arguments while it reports jobs still running), ' +
  'production_add_audio (an instrumental music prompt, voiceover on, optionally one sound effect per shot), ' +
  'then production_assemble. Do not ask the user questions unless a tool refuses; when you do, end the question ' +
  `with the production id (${compositionId}) so your next turn has it. ` +
  'End with a short summary of what was made.';
