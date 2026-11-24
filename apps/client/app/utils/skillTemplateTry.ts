import { skillTemplateFreeRunInputKey } from '@bike4mind/common';

/** The visitor's free-run text for a template page, or '' when there is none or storage is blocked. */
export function readFreeRunInput(slug: string): string {
  try {
    return window.localStorage.getItem(skillTemplateFreeRunInputKey(slug))?.trim() ?? '';
  } catch {
    return '';
  }
}

export function clearFreeRunInput(slug: string): void {
  try {
    window.localStorage.removeItem(skillTemplateFreeRunInputKey(slug));
  } catch {
    // Storage blocked: nothing was read from it either.
  }
}

/** The `/new?goal=` text: the skill's slash command, then the prompt when there is one. */
export const skillTemplateGoal = (skillName: string, prompt: string): string =>
  prompt.trim() ? `/${skillName} ${prompt.trim()}` : `/${skillName} `;
