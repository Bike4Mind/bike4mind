/** Quotes a word for a POSIX shell so a pasted command passes it as one argument. */
export const shellWord = (word: string): string =>
  /^[\w.:/@-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
