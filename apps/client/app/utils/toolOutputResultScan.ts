// Linear-time stand-ins for four of convertToolOutputsToArtifacts' patterns (./artifactParser.ts).
// Each returns what text.replace(pattern, replacer) returned, and passes the replacer the same
// (match, captured) pair. The regex forms rescan to the end of the input from every prefix or
// brace, which is quadratic on repeated unclosed ones.

export type ResultReplacer = (match: string, captured: string) => string;

function nextIndexOf(text: string, needle: string, from: number): number {
  const at = text.indexOf(needle, from);
  return at === -1 ? Infinity : at;
}

// Successive prefix matches end strictly further right, so every pointer below only moves forward.

// text.replace(/"result":\s*"(\{.*?\})"/g, replacer)
export function replaceLazyResultObjects(text: string, replacer: ResultReplacer): string {
  const prefix = /"result":\s*"\{/g;
  const lineTerminator = /[\n\r\u2028\u2029]/g;
  let out = '';
  let copied = 0;
  let closeAt = -1;
  let lineEndAt = -1;
  for (let m = prefix.exec(text); m; m = prefix.exec(text)) {
    const brace = prefix.lastIndex - 1;
    if (closeAt <= brace) closeAt = nextIndexOf(text, '}"', brace + 1);
    if (closeAt === Infinity) break;
    if (lineEndAt <= brace) {
      lineTerminator.lastIndex = brace + 1;
      lineEndAt = lineTerminator.exec(text)?.index ?? Infinity;
    }
    if (closeAt < lineEndAt) {
      const end = closeAt + 2;
      out += text.slice(copied, m.index) + replacer(text.slice(m.index, end), text.slice(brace, closeAt + 1));
      copied = end;
      prefix.lastIndex = end;
    } else {
      prefix.lastIndex = m.index + 1;
    }
  }
  return out + text.slice(copied);
}

// text.replace(new RegExp(prefix.source + '[^}]*\\}"', 'g'), replacer), where prefix's last
// capture group runs to the end of the prefix and the captured text ends at (or, with
// keepBrace, includes) the closing brace.
function replaceBraceTerminated(text: string, prefix: RegExp, keepBrace: boolean, replacer: ResultReplacer): string {
  let out = '';
  let copied = 0;
  let braceAt = -1;
  for (let m = prefix.exec(text); m; m = prefix.exec(text)) {
    const prefixEnd = prefix.lastIndex;
    if (braceAt < prefixEnd) braceAt = nextIndexOf(text, '}', prefixEnd);
    if (braceAt === Infinity) break;
    if (text[braceAt + 1] === '"') {
      const end = braceAt + 2;
      const captured = text.slice(prefixEnd - m[1].length, keepBrace ? braceAt + 1 : braceAt);
      out += text.slice(copied, m.index) + replacer(text.slice(m.index, end), captured);
      copied = end;
      prefix.lastIndex = end;
    } else {
      prefix.lastIndex = m.index + 1;
    }
  }
  return out + text.slice(copied);
}

// text.replace(/"result":\s*"(\{\\?"[^"]*\\?":\s*\\?"[^"]*\\?"[^}]*\})"/g, replacer)
export function replaceEscapedResultObjects(text: string, replacer: ResultReplacer): string {
  return replaceBraceTerminated(text, /"result":\s*"(\{\\?"[^"]*\\?":\s*\\?"[^"]*\\?")/g, true, replacer);
}

// text.replace(/"result":\s*"\{(\\\\"type\\\\":\\\\"(?:rechart|recharts|mermaid)\\\\"[^}]*)\}"/g, replacer)
export function replaceLogFormatResultObjects(text: string, replacer: ResultReplacer): string {
  return replaceBraceTerminated(
    text,
    /"result":\s*"\{(\\\\"type\\\\":\\\\"(?:rechart|recharts|mermaid)\\\\")/g,
    false,
    replacer
  );
}

const DIRECT_TYPE = /"type"\s*:\s*"(?:rechart|recharts|mermaid)"/;
const BRACE = /[{}]/g;

// text.replace(/(\{[^{}]*"type"\s*:\s*"(?:rechart|recharts|mermaid)"[^{}]*\})/g, replacer).
// Neither [^{}]* crosses a brace, so a match runs from a '{' to the next brace, which must be '}'.
export function replaceDirectTypeObjects(text: string, replacer: ResultReplacer): string {
  let out = '';
  let copied = 0;
  let open = text.indexOf('{');
  while (open !== -1) {
    BRACE.lastIndex = open + 1;
    const next = BRACE.exec(text);
    if (!next) break;
    if (next[0] === '}' && DIRECT_TYPE.test(text.slice(open + 1, next.index))) {
      const match = text.slice(open, next.index + 1);
      out += text.slice(copied, open) + replacer(match, match);
      copied = next.index + 1;
      open = text.indexOf('{', copied);
    } else {
      open = next[0] === '{' ? next.index : text.indexOf('{', next.index + 1);
    }
  }
  return out + text.slice(copied);
}
