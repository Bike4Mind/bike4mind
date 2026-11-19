import type { SpeechWordTiming } from '../voiceGeneration';
import {
  STUDIO_TIMELINE_LIMITS,
  StudioCaptionStyleSchema,
  type StudioAudioClip,
  type StudioCaptionClip,
  type StudioCaptionStyle,
  type StudioTimeline,
  type StudioTimelineTrack,
} from './timeline';

/**
 * Captions timed from a voice line: split its script into short phrases, time each phrase from the provider's word
 * alignment when it matches the script (or spread the phrases over the clip when it does not), and lay them onto
 * the timeline under the voice clip. Shared by the Productions editor and the assistant director, so both caption
 * a voice line the same way.
 */

/** One caption phrase, in ms from the start of the voice clip's audio (its source, before any trim). */
export type VoiceCaptionCue = { text: string; startMs: number; endMs: number };

export type VoiceCaptionTiming = 'aligned' | 'estimated';

export const VOICE_CAPTION_PHRASING = {
  maxWords: 6,
  maxChars: 32,
  /** A clause break (comma, colon...) ends a phrase once it holds this many words. */
  minWordsBeforeClauseBreak: 3,
  /** A silence at least this long between two aligned words ends a phrase. */
  pauseBreakMs: 350,
  /** How long an aligned phrase stays up after its last word, unless the next phrase starts sooner. */
  holdMs: 400,
} as const;

/** Shorter than this a caption cannot be read; matches the editor's minimum clip length. */
const MIN_CAPTION_MS = 100;

// Built from strings so the non-ASCII marks stay ASCII escapes (a lint autofix would inline a regex literal's).
// Sentence ends: . ! ? and the ellipsis, plus the CJK full stop, exclamation and question marks.
const SENTENCE_END = new RegExp('[.!?\\u2026\\u3002\\uff01\\uff1f]["\')\\]\\u300d\\u300f]*$');
// Clause breaks: , ; : and the en and em dashes, plus the CJK comma, enumeration comma, semicolon and colon.
const CLAUSE_END = new RegExp('[,;:\\u2013\\u2014\\u3001\\uff0c\\uff1b\\uff1a]["\')\\]\\u300d\\u300f]*$');
const CJK_BREAK_AFTER = new RegExp('[\\u3001\\u3002\\uff01\\uff0c\\uff1a\\uff1b\\uff1f]');

const scriptWords = (script: string): string[] => script.split(/\s+/).filter(word => word.length > 0);

/** `glued`: a piece of a longer token, written straight after the previous piece with no space between them. */
type Word = { text: string; startMs?: number; endMs?: number; glued?: boolean };

const joinWords = (words: readonly Word[]): string =>
  words.map((word, index) => (index > 0 && !word.glued ? ` ${word.text}` : word.text)).join('');

/**
 * Cuts a token longer than a phrase into phrase-sized pieces, after CJK punctuation where it can. Scripts without
 * spaces (Japanese, Chinese, Thai) are one token per sentence or more, which would otherwise be one huge caption.
 * A timed token's time is shared between its pieces by character count.
 */
const splitLongWord = <W extends Word>(word: W): W[] => {
  const characters = Array.from(word.text);
  if (characters.length <= VOICE_CAPTION_PHRASING.maxChars) return [word];
  const bounds: Array<[number, number]> = [];
  let pieceStart = 0;
  characters.forEach((character, index) => {
    const pieceLength = index + 1 - pieceStart;
    if (CJK_BREAK_AFTER.test(character) || pieceLength >= VOICE_CAPTION_PHRASING.maxChars) {
      bounds.push([pieceStart, index + 1]);
      pieceStart = index + 1;
    }
  });
  if (pieceStart < characters.length) bounds.push([pieceStart, characters.length]);
  const timeAt = (charIndex: number) =>
    word.startMs === undefined || word.endMs === undefined
      ? undefined
      : Math.round(word.startMs + ((word.endMs - word.startMs) * charIndex) / characters.length);
  return bounds.map(([from, to], index) => ({
    ...word,
    text: characters.slice(from, to).join(''),
    startMs: timeAt(from),
    endMs: timeAt(to),
    glued: index > 0 ? true : word.glued,
  }));
};

const endsPhraseAfter = (phrase: Word[], word: Word, next: Word | undefined): boolean => {
  if (!next) return true;
  if (SENTENCE_END.test(word.text)) return true;
  if (CLAUSE_END.test(word.text) && phrase.length >= VOICE_CAPTION_PHRASING.minWordsBeforeClauseBreak) return true;
  const charsWithNext = joinWords([...phrase, next]).length;
  if (charsWithNext > VOICE_CAPTION_PHRASING.maxChars) return true;
  // One word over the cap is kept when it ends the sentence, so it is not left as a flash-length caption alone.
  const finishesSentence = phrase.length === VOICE_CAPTION_PHRASING.maxWords && SENTENCE_END.test(next.text);
  if (phrase.length >= VOICE_CAPTION_PHRASING.maxWords && !finishesSentence) return true;
  const gapMs = next.startMs !== undefined && word.endMs !== undefined ? next.startMs - word.endMs : 0;
  return gapMs >= VOICE_CAPTION_PHRASING.pauseBreakMs;
};

/** Groups words into caption phrases: a few words each, broken at sentence ends, clause breaks and pauses. */
const groupPhrases = <W extends Word>(words: W[]): W[][] => {
  const phrases: W[][] = [];
  let phrase: W[] = [];
  words.forEach((word, index) => {
    phrase.push(word);
    if (endsPhraseAfter(phrase, word, words[index + 1])) {
      phrases.push(phrase);
      phrase = [];
    }
  });
  return phrases;
};

/** The script's phrases, as caption text. */
export const splitCaptionPhrases = (script: string): string[] =>
  groupPhrases(scriptWords(script).flatMap(text => splitLongWord<Word>({ text }))).map(joinWords);

/**
 * The provider's word timings, when they are timings of exactly this script (same words, same order). A user who
 * edited the script after generating the voice gets undefined, and so the estimate, rather than shifted captions.
 */
const alignedWords = (script: string, wordTimings: readonly SpeechWordTiming[] | undefined) => {
  if (!wordTimings || wordTimings.length === 0) return undefined;
  const words = scriptWords(script);
  if (words.length !== wordTimings.length) return undefined;
  const matches = words.every((word, index) => word === wordTimings[index].text);
  return matches ? wordTimings : undefined;
};

type TimedWord = SpeechWordTiming & { glued?: boolean };

const alignedCues = (wordTimings: readonly SpeechWordTiming[]): VoiceCaptionCue[] => {
  const phrases = groupPhrases(wordTimings.flatMap(word => splitLongWord<TimedWord>(word)));
  return phrases.map((phrase, index) => {
    const startMs = phrase[0].startMs;
    const nextStartMs = phrases[index + 1]?.[0].startMs ?? Number.POSITIVE_INFINITY;
    const spokenEndMs = Math.max(phrase[phrase.length - 1].endMs, startMs + MIN_CAPTION_MS);
    return {
      text: joinWords(phrase),
      startMs,
      endMs: Math.min(spokenEndMs + VOICE_CAPTION_PHRASING.holdMs, Math.max(nextStartMs, startMs + MIN_CAPTION_MS)),
    };
  });
};

/** Without alignment, phrases share the clip in proportion to their length, which tracks speaking time closely. */
const estimatedCues = (phrases: string[], audioDurationMs: number): VoiceCaptionCue[] => {
  const totalChars = phrases.reduce((sum, phrase) => sum + phrase.length, 0);
  let elapsedChars = 0;
  return phrases.map(text => {
    const startMs = Math.round((elapsedChars / totalChars) * audioDurationMs);
    elapsedChars += text.length;
    return { text, startMs, endMs: Math.round((elapsedChars / totalChars) * audioDurationMs) };
  });
};

export type BuildVoiceCaptionCuesInput = {
  script: string;
  /** The speech job's word timings, when its provider reported them. */
  wordTimings?: readonly SpeechWordTiming[];
  /** The voice clip's whole audio, used to spread phrases when there is no usable alignment. */
  audioDurationMs: number;
};

/** Caption cues for a voice line, timed from its word alignment when that matches the script, else estimated. */
export const buildVoiceCaptionCues = ({
  script,
  wordTimings,
  audioDurationMs,
}: BuildVoiceCaptionCuesInput): { cues: VoiceCaptionCue[]; timing: VoiceCaptionTiming } => {
  const aligned = alignedWords(script, wordTimings);
  if (aligned) return { cues: alignedCues(aligned), timing: 'aligned' };
  const phrases = splitCaptionPhrases(script);
  if (phrases.length === 0 || audioDurationMs <= 0) return { cues: [], timing: 'estimated' };
  return { cues: estimatedCues(phrases, audioDurationMs), timing: 'estimated' };
};

export type VoiceCaptionClipsInput = {
  voiceClip: Pick<StudioAudioClip, 'id' | 'startMs' | 'durationMs' | 'trimStartMs'>;
  cues: readonly VoiceCaptionCue[];
  timelineDurationMs: number;
  mintId: () => string;
  /** Link each caption to the voice clip, so moving the clip moves its captions (see shiftSyncedCaptions). */
  sync: boolean;
  style?: StudioCaptionStyle;
};

/**
 * Lays cues onto the timeline under a voice clip. Only what the clip actually plays is captioned: a cue the trim
 * cuts off is dropped and one it cuts into is shortened. The result is sorted and never overlaps.
 */
export const voiceCaptionClips = ({
  voiceClip,
  cues,
  timelineDurationMs,
  mintId,
  sync,
  style = StudioCaptionStyleSchema.parse({}),
}: VoiceCaptionClipsInput): StudioCaptionClip[] => {
  const audioStartMs = voiceClip.startMs - voiceClip.trimStartMs;
  const windowStartMs = Math.max(0, voiceClip.startMs);
  const windowEndMs = Math.min(timelineDurationMs, voiceClip.startMs + voiceClip.durationMs);
  const clips: StudioCaptionClip[] = [];
  for (const cue of cues) {
    const previousEndMs = clips.length > 0 ? clips[clips.length - 1].startMs + clips[clips.length - 1].durationMs : 0;
    const startMs = Math.max(Math.round(audioStartMs + cue.startMs), windowStartMs, previousEndMs);
    const endMs = Math.min(Math.round(audioStartMs + cue.endMs), windowEndMs);
    if (endMs - startMs < MIN_CAPTION_MS) continue;
    clips.push({
      id: mintId(),
      startMs,
      durationMs: endMs - startMs,
      text: cue.text,
      style,
      ...(sync && { syncedVoiceClipId: voiceClip.id }),
    });
  }
  return clips;
};

const overlaps = (a: { startMs: number; durationMs: number }, b: { startMs: number; durationMs: number }) =>
  a.startMs < b.startMs + b.durationMs && b.startMs < a.startMs + a.durationMs;

const isCaptionsTrack = (track: StudioTimelineTrack): track is Extract<StudioTimelineTrack, { kind: 'captions' }> =>
  track.kind === 'captions';

/**
 * Puts a voice clip's captions on the first enabled captions track (adding one when there is none, since captions
 * on a hidden track would not render), replacing the captions previously synced to that clip. Throws when a new
 * caption would land on another caption, since quietly moving or deleting someone's hand-made caption is worse than
 * asking them to make room, and when the track would go over its clip limit.
 */
export const replaceVoiceCaptions = (
  timeline: StudioTimeline,
  voiceClipId: string,
  captions: readonly StudioCaptionClip[],
  mintTrackId: () => string
): StudioTimeline => {
  const withoutOld = timeline.tracks.map(track =>
    isCaptionsTrack(track)
      ? { ...track, clips: track.clips.filter(clip => clip.syncedVoiceClipId !== voiceClipId) }
      : track
  );
  const targetIndex = withoutOld.findIndex(track => isCaptionsTrack(track) && track.enabled);
  const target =
    targetIndex >= 0
      ? (withoutOld[targetIndex] as Extract<StudioTimelineTrack, { kind: 'captions' }>)
      : { id: mintTrackId(), kind: 'captions' as const, enabled: true, clips: [] };
  const blocked = captions.filter(caption => target.clips.some(existing => overlaps(existing, caption))).length;
  if (blocked > 0) {
    throw new Error(
      `${blocked} of the new captions would overlap captions already on the track. Move or remove those captions first.`
    );
  }
  const clipCount = target.clips.length + captions.length;
  if (clipCount > STUDIO_TIMELINE_LIMITS.maxClipsPerTrack) {
    throw new Error(
      `That would put ${clipCount} clips on the captions track, over the limit of ${STUDIO_TIMELINE_LIMITS.maxClipsPerTrack}. Shorten the script or remove some captions first.`
    );
  }
  const track = { ...target, clips: [...target.clips, ...captions].sort((a, b) => a.startMs - b.startMs) };
  const tracks =
    targetIndex >= 0
      ? withoutOld.map((existing, index) => (index === targetIndex ? track : existing))
      : [...withoutOld, track];
  return { ...timeline, tracks };
};

/** Where a voice clip's audio would start on the timeline: the anchor its synced captions are timed from. */
const voiceAnchors = (timeline: StudioTimeline): Map<string, number> => {
  const anchors = new Map<string, number>();
  for (const track of timeline.tracks) {
    if (track.kind !== 'voice') continue;
    for (const clip of track.clips) anchors.set(clip.id, clip.startMs - clip.trimStartMs);
  }
  return anchors;
};

/**
 * Keeps synced captions on their voice: after an edit that moved or slip-trimmed a voice clip's audio, each caption
 * synced to it moves by the same amount. A caption pushed partly off the timeline is cut to what is left (never
 * slid back, which would stack it on its neighbour) and one pushed off entirely is dropped. A caption whose voice clip is gone keeps its
 * place and loses the link. Returns `next` itself when nothing needed to change, so callers can compare references.
 */
export const shiftSyncedCaptions = (previous: StudioTimeline, next: StudioTimeline): StudioTimeline => {
  const before = voiceAnchors(previous);
  const after = voiceAnchors(next);
  let changed = false;
  const tracks = next.tracks.map(track => {
    if (!isCaptionsTrack(track)) return track;
    let trackChanged = false;
    const clips = track.clips.flatMap((clip): StudioCaptionClip[] => {
      const voiceClipId = clip.syncedVoiceClipId;
      if (voiceClipId === undefined) return [clip];
      const anchorAfter = after.get(voiceClipId);
      if (anchorAfter === undefined) {
        trackChanged = true;
        const { syncedVoiceClipId: _dropped, ...unlinked } = clip;
        return [unlinked];
      }
      const anchorBefore = before.get(voiceClipId);
      if (anchorBefore === undefined || anchorBefore === anchorAfter) return [clip];
      trackChanged = true;
      const shiftedStartMs = clip.startMs + anchorAfter - anchorBefore;
      const startMs = Math.max(shiftedStartMs, 0);
      const endMs = Math.min(shiftedStartMs + clip.durationMs, next.durationMs);
      return endMs - startMs < MIN_CAPTION_MS ? [] : [{ ...clip, startMs, durationMs: endMs - startMs }];
    });
    if (!trackChanged) return track;
    changed = true;
    return { ...track, clips };
  });
  return changed ? { ...next, tracks } : next;
};
