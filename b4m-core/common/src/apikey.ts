export function obfuscateApiKey(apiKey: string) {
  if (!apiKey) return apiKey;
  // Keys shorter than 6 chars return unobfuscated - repeat(-N) produces ''
  return `${apiKey.slice(0, 3)}${'*'.repeat(apiKey.length - 6)}${apiKey.slice(-3)}`;
}
