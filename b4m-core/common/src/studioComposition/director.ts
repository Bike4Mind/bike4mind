import type { B4MLLMTools } from '../schemas/llm';

/**
 * The production tools a directed notebook runs with. The Direct launch narrows the agent to exactly these, and
 * every later turn in a session marked with `productionCompositionId` gets them back (the client forces agent mode
 * with them; the agent executor re-adds them). Must stay in sync with PRODUCTION_TOOL_NAMES in
 * @bike4mind/services (llm/tools/implementation/production/config.ts).
 */
export const DIRECTOR_TOOLS: readonly B4MLLMTools[] = [
  'production_storyboard',
  'production_generate_shot',
  'production_add_audio',
  'production_assemble',
];

/** The director's system context; the agent executor injects it on every run in a directed session. */
export const buildDirectorSystemContext = (compositionId: string): string =>
  `You are directing the Studio production ${compositionId}. Use the production tools in order: ` +
  'production_storyboard (about 4 shots for a 15-30 second ad, each with an image prompt, a length and a voiceover line; ' +
  'pass a new product photo as productFileId; one already in the brand kit is used without it), ' +
  'production_generate_shot (call it again with the same arguments while it reports jobs still running), ' +
  'production_add_audio (an instrumental music prompt, voiceover on, optionally one sound effect per shot), ' +
  'then production_assemble. Do not ask the user questions unless a tool refuses. ' +
  'When the user says a new brief replaces the current ad, rewrite it with rewriteLines and replace and no keep. ' +
  'Otherwise, on a later turn, call production_storyboard with keep (the shot id) for every shot you are not ' +
  're-imagining, ' +
  'and only claim a shot kept its clip when the storyboard result says takesKept for it. ' +
  'Change the production only through these tools, on every turn: never say a step is done, or not done, unless a ' +
  'tool result in this conversation shows it. ' +
  'End with a short summary of what was made.';
