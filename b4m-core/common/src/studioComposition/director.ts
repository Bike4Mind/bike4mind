import type { B4MLLMTools } from '../schemas/llm';
import {
  STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS,
  type StudioCompositionContent,
  type StudioCompositionTemplate,
} from './composition';

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

/** Most shots one production_storyboard call takes. */
export const DIRECTOR_MAX_SHOTS = 12;
const FILM_MIN_SHOTS = 3;
// The storyboard tool takes shots of up to 30 seconds, so a longer timeline cannot be filled by one call.
const FILM_MAX_SHOTS_SECONDS = DIRECTOR_MAX_SHOTS * 30;
// A short film cuts roughly every 6 to 10 seconds.
const FILM_SECONDS_PER_SHOT = { min: 6, max: 10 } as const;

/** What the director's instructions depend on, read from the production. */
export type StudioDirectorBriefing = {
  template: StudioCompositionTemplate;
  tone?: string;
  durationMs?: number;
};

export const studioDirectorBriefing = (
  composition: Pick<StudioCompositionContent, 'template' | 'brief' | 'timeline'>
): StudioDirectorBriefing => ({
  template: composition.template,
  ...(composition.brief.tone && { tone: composition.brief.tone }),
  durationMs: composition.timeline.durationMs,
});

const clampShots = (count: number): number => Math.min(DIRECTOR_MAX_SHOTS, Math.max(FILM_MIN_SHOTS, count));

/** The shot count a film of this length gets, as "N" or "N to M". */
export const filmShotRange = (durationMs: number): string => {
  const seconds = durationMs / 1000;
  const fewest = clampShots(Math.ceil(seconds / FILM_SECONDS_PER_SHOT.max));
  const most = clampShots(Math.floor(seconds / FILM_SECONDS_PER_SHOT.min));
  return fewest === most ? `${fewest}` : `${fewest} to ${most}`;
};

const followUpRules = (piece: string): string =>
  'Do not ask the user questions unless a tool refuses. ' +
  `Only when the latest user message says a new brief replaces the current ${piece}, rewrite it with rewriteLines and ` +
  'replace and no keep; an earlier message saying so does not carry over. ' +
  'Otherwise, on a later turn, call production_storyboard with keep (the shot id) for every shot you are not ' +
  're-imagining, ' +
  'and only claim a shot kept its clip when the storyboard result says takesKept for it. ' +
  'When the user asks to reword a line, pass the new voiceLine with rewriteLines. ' +
  'Change the production only through these tools, on every turn: never say a step is done, or not done, unless a ' +
  'tool result in this conversation shows it. ' +
  'End with a short summary of what was made. It must name every line in linesRemoved, linesChanged and ' +
  'linesMoved and every shot in takesDropped from this turn, and quote voice lines only as the latest storyboard ' +
  'result lists them; never say lines were left as they were when a result lists one.';

/** How every director context opens, whatever the template; the worker recognizes a launch's context by it. */
export const directorContextLead = (compositionId: string): string =>
  `You are directing the Studio production ${compositionId}`;

const adContext = (compositionId: string): string =>
  `${directorContextLead(compositionId)}. Use the production tools in order: ` +
  'production_storyboard (about 4 shots for a 15-30 second ad, each with an image prompt, a length and a voiceover line; ' +
  'pass a new product photo as productFileId; one already in the brand kit is used without it), ' +
  'production_generate_shot (call it again with the same arguments while it reports jobs still running), ' +
  'production_add_audio (an instrumental music prompt, voiceover on, optionally one sound effect per shot), ' +
  'then production_assemble. ' +
  followUpRules('ad');

const filmContext = (compositionId: string, { tone, durationMs }: StudioDirectorBriefing): string => {
  const length = durationMs ?? STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS.short_film.durationMs;
  const seconds = Math.round(length / 1000);
  const shotsSeconds = Math.min(seconds, FILM_MAX_SHOTS_SECONDS);
  return (
    `${directorContextLead(compositionId)}, a short film of about ${seconds} seconds` +
    (tone ? ` in a ${JSON.stringify(tone)} tone. ` : '. ') +
    'Tell one story with a beginning (set up the character and their world), a middle (an inciting moment and a ' +
    'turn that raises the stakes) and an end (a climax and a resolution). It is not an ad: no product, no call to ' +
    'action, no hook. Use the production tools in order: ' +
    `production_storyboard (${filmShotRange(length)} shots whose lengths add up to about ${shotsSeconds} seconds, each ` +
    'with an image prompt, a length and a narration line; read in order the lines must tell the story, and every ' +
    'prompt describes the same characters, places and look so the shots match; leave productFileId out), ' +
    'production_generate_shot (call it again with the same arguments while it reports jobs still running), ' +
    `production_add_audio (an instrumental music prompt that matches the ${tone ? 'tone' : 'mood of the story'}, ` +
    'voiceover on, optionally one sound effect per shot), ' +
    'then production_assemble. ' +
    followUpRules('film')
  );
};

/**
 * The director's system context; the agent executor injects it on every run in a directed session. A short film
 * gets narrative instructions; every other template is directed as an ad.
 */
export const buildDirectorSystemContext = (compositionId: string, briefing?: StudioDirectorBriefing): string =>
  briefing?.template === 'short_film' ? filmContext(compositionId, briefing) : adContext(compositionId);
