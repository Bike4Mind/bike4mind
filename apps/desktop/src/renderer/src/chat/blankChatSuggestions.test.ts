import { describe, expect, it } from 'vitest';
import type { CreationTool } from '@shared/chat';
import { blankChatSubline, blankChatSuggestions, pickPrompt } from './blankChatSuggestions';

const tool = (name: string): CreationTool => ({ name, spendsCredits: true });
const ALL = ['generate_image', 'generate_speech', 'generate_sound_effect', 'generate_music', 'generate_video'].map(
  tool
);

describe('blankChatSuggestions', () => {
  it('shows every offered media category, in order, then the text cards', () => {
    expect(blankChatSuggestions(ALL, 's1').map(s => s.category)).toEqual([
      'image',
      'video',
      'voice',
      'sound',
      'music',
      'write',
    ]);
  });

  it('hides video when generate_video is not offered', () => {
    const categories = blankChatSuggestions(
      ALL.filter(t => t.name !== 'generate_video'),
      's1'
    ).map(s => s.category);
    expect(categories).not.toContain('video');
    expect(categories).toEqual(['image', 'voice', 'sound', 'music', 'write', 'ask']);
  });

  it('falls back to the text cards when nothing can be generated', () => {
    expect(blankChatSuggestions([], 's1').map(s => s.category)).toEqual(['write', 'ask']);
  });

  it('picks the same prompt for the same session id every time', () => {
    const first = blankChatSuggestions(ALL, 'session-42').map(s => s.prompt);
    expect(blankChatSuggestions(ALL, 'session-42').map(s => s.prompt)).toEqual(first);
  });

  it('rotates prompts across session ids', () => {
    const prompts = ['a', 'b', 'c'];
    const seen = new Set(Array.from({ length: 30 }, (_, i) => pickPrompt(prompts, `s${i}`, 'image')));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('blankChatSubline', () => {
  it('names only what can be made', () => {
    expect(blankChatSubline(ALL)).toBe('Chat, write, or create images, video, voice, sound effects and music.');
    expect(blankChatSubline([tool('generate_image'), tool('generate_music')])).toBe(
      'Chat, write, or create images and music.'
    );
  });

  it('does not promise media when none is offered', () => {
    expect(blankChatSubline([])).not.toMatch(/create/);
  });
});
