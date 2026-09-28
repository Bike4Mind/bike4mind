export interface ArtifactTagBlock {
  index: number;
  end: number;
  attrs: string;
  body: string;
}

const OPENER = /<artifact/gi;
const CLOSER = /<\/artifact>/gi;
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;
const WHITESPACE = /\s/;
const OPENER_LENGTH = '<artifact'.length;
const CLOSER_LENGTH = '</artifact>'.length;

// First match of `pattern` at or after `from`, cached so monotone queries stay linear overall.
function forwardFinder(content: string, pattern: RegExp): (from: number) => number {
  const re = new RegExp(pattern.source, pattern.flags);
  let found = -2;
  return from => {
    if (found === -1 || found >= from) return found;
    re.lastIndex = from;
    found = re.exec(content)?.index ?? -1;
    return found;
  };
}

function scanTagBlocks(content: string, attrsStopAtLineBreak: boolean): ArtifactTagBlock[] {
  const blocks: ArtifactTagBlock[] = [];
  const nextGt = forwardFinder(content, />/g);
  const nextCloser = forwardFinder(content, CLOSER);
  const nextLineBreak = forwardFinder(content, LINE_TERMINATOR);
  const opener = new RegExp(OPENER.source, OPENER.flags);
  let opened: RegExpExecArray | null;

  while ((opened = opener.exec(content)) !== null) {
    const index = opened.index;
    let attrsStart = index + OPENER_LENGTH;
    while (attrsStart < content.length && WHITESPACE.test(content[attrsStart])) attrsStart++;
    if (attrsStart === index + OPENER_LENGTH) continue;

    // Backtracking the whitespace run can only add more prefix before the same '>', so the
    // greedy run is the only split that can match.
    const gt = nextGt(attrsStart);
    if (gt === -1) continue;
    if (attrsStopAtLineBreak) {
      const lineBreak = nextLineBreak(attrsStart);
      if (lineBreak !== -1 && lineBreak < gt) continue;
    }
    const closer = nextCloser(gt + 1);
    if (closer === -1) continue;

    const end = closer + CLOSER_LENGTH;
    blocks.push({ index, end, attrs: content.slice(attrsStart, gt), body: content.slice(gt + 1, closer) });
    opener.lastIndex = end;
  }
  return blocks;
}

/** Same matches and captures as /<artifact\s+(.*?)>([\s\S]*?)<\/artifact>/gi, in linear time. */
export function matchArtifactTagBlocks(content: string): ArtifactTagBlock[] {
  return scanTagBlocks(content, true);
}

/** Same matches and captures as /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi, in linear time. */
export function matchToolArtifactTagBlocks(content: string): ArtifactTagBlock[] {
  return scanTagBlocks(content, false);
}

/** Same result as content.replace(/<artifact\s+.*?>([\s\S]*?)<\/artifact>/gi, ''), in linear time. */
export function stripArtifactTagBlocks(content: string): string {
  let kept = '';
  let keptFrom = 0;
  for (const block of matchArtifactTagBlocks(content)) {
    kept += content.slice(keptFrom, block.index);
    keptFrom = block.end;
  }
  return kept + content.slice(keptFrom);
}
