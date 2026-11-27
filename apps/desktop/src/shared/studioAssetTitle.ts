import type { StudioAsset } from './studio';

export function titleFromStudioPrompt(prompt: string | undefined, fallback: string): string {
  const text = prompt
    ?.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}\s+|>\s*|[-*+]\s+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^draft\b[\s:;\-\u2013\u2014]*/i, '')
    .replace(
      /^(?:(?:background\s+)?music\s+concept|visual\s+brief|furniture\s+direction|script|image\s+prompt|video\s+prompt)\b\s*/i,
      ''
    )
    .replace(/^[\s:;\-\u2013\u2014]+/, '');
  if (!text) return fallback;
  return shortenTitle(text, fallback);
}

function shortenTitle(text: string, fallback: string): string {
  const words = text.split(' ');
  let title = words.slice(0, 8).join(' ');
  if (title.length > 64) {
    title = title.slice(0, 64);
    const boundary = title.lastIndexOf(' ');
    if (boundary > 32) title = title.slice(0, boundary);
  }
  title = title.replace(/[\s,;:.!?-]+$/, '');
  return title ? title[0].toLocaleUpperCase() + title.slice(1) : fallback;
}

export function studioAssetTitle(asset: StudioAsset): string {
  const generic = ['image', 'video', 'music', 'speech', 'voice', 'sound-effect', 'sound effect', 'sound fx'];
  const prompt = asset.creation?.prompt ?? asset.prompt;
  const previousGeneratedTitle = prompt ? shortenTitle(prompt.replace(/\s+/g, ' ').trim(), asset.kind) : undefined;
  return generic.includes(asset.title.trim().toLowerCase()) || asset.title === previousGeneratedTitle
    ? titleFromStudioPrompt(prompt, asset.kind)
    : asset.title;
}
