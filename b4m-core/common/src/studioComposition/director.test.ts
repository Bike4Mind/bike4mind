import { describe, expect, it } from 'vitest';
import { defaultStudioTimeline } from './composition';
import { DIRECTOR_MAX_SHOTS, buildDirectorSystemContext, filmShotRange, studioDirectorBriefing } from './director';

const ID = '64b7f0c2a1b2c3d4e5f60718';

// The ad wording as it shipped before templates were told apart; ad productions must keep getting it unchanged.
const AD_CONTEXT =
  `You are directing the Studio production ${ID}. Use the production tools in order: ` +
  'production_storyboard (about 4 shots for a 15-30 second ad, each with an image prompt, a length and a voiceover line; ' +
  'pass a new product photo as productFileId; one already in the brand kit is used without it), ' +
  'production_generate_shot (call it again with the same arguments while it reports jobs still running), ' +
  'production_add_audio (an instrumental music prompt, voiceover on, optionally one sound effect per shot), ' +
  'then production_assemble. Do not ask the user questions unless a tool refuses. ' +
  'Only when the latest user message says a new brief replaces the current ad, rewrite it with rewriteLines and ' +
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

describe('buildDirectorSystemContext', () => {
  it('keeps the ad wording byte for byte with no briefing or an ad briefing', () => {
    expect(buildDirectorSystemContext(ID)).toBe(AD_CONTEXT);
    expect(buildDirectorSystemContext(ID, { template: 'ad_campaign', tone: 'calm', durationMs: 90_000 })).toBe(
      AD_CONTEXT
    );
  });

  it('directs templates other than the short film as an ad', () => {
    expect(buildDirectorSystemContext(ID, { template: 'explainer' })).toBe(AD_CONTEXT);
  });

  it('directs a short film as a story in three acts with narration, sized to its length and tone', () => {
    const context = buildDirectorSystemContext(ID, { template: 'short_film', tone: 'wistful', durationMs: 90_000 });
    expect(context).toContain(`production ${ID}, a short film of about 90 seconds in a "wistful" tone.`);
    expect(context).toMatch(/a beginning .* a middle .* an end/);
    expect(context).toContain('no product, no call to action');
    expect(context).toContain('9 to 12 shots whose lengths add up to about 90 seconds');
    expect(context).toContain('narration line');
    expect(context).toContain('leave productFileId out');
    expect(context).toContain('music prompt that matches the tone');
    expect(context).toContain('says a new brief replaces the current film');
    expect(context).not.toContain('15-30 second ad');
    expect(context).not.toContain('brand kit');
  });

  it('falls back to the template length and the story mood without a length or tone', () => {
    const context = buildDirectorSystemContext(ID, { template: 'short_film' });
    expect(context).toContain('a short film of about 60 seconds. Tell one story');
    expect(context).toContain('6 to 10 shots whose lengths add up to about 60 seconds');
    expect(context).toContain('matches the mood of the story');
  });

  it('asks for no more shot time than the storyboard tool can take for a very long timeline', () => {
    const context = buildDirectorSystemContext(ID, { template: 'short_film', durationMs: 600_000 });
    expect(context).toContain('a short film of about 600 seconds');
    expect(context).toContain(
      `${DIRECTOR_MAX_SHOTS} shots whose lengths add up to about ${DIRECTOR_MAX_SHOTS * 30} seconds`
    );
  });
});

describe('filmShotRange', () => {
  it.each([
    [30_000, '3 to 5'],
    [60_000, '6 to 10'],
    [90_000, '9 to 12'],
    [120_000, '12'],
    [10_000, '3'],
    [600_000, `${DIRECTOR_MAX_SHOTS}`],
  ])('cuts a %i ms film into %s shots', (durationMs, range) => {
    expect(filmShotRange(durationMs)).toBe(range);
  });
});

describe('studioDirectorBriefing', () => {
  it('reads the template, tone and timeline length', () => {
    const timeline = defaultStudioTimeline('short_film', { durationMs: 30_000 });
    expect(studioDirectorBriefing({ template: 'short_film', brief: { tone: 'tense' }, timeline })).toEqual({
      template: 'short_film',
      tone: 'tense',
      durationMs: 30_000,
    });
  });

  it('leaves out an unset tone', () => {
    const timeline = defaultStudioTimeline('ad_campaign');
    expect(studioDirectorBriefing({ template: 'ad_campaign', brief: {}, timeline })).toEqual({
      template: 'ad_campaign',
      durationMs: 15_000,
    });
  });
});
