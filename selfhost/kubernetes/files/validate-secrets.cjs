// Startup check for the at-rest encryption keys. Compose runs this file from the app image
// (with --allow-plaintext-opt-out); the Helm chart inlines it into its validate-secrets init
// container (no flag, so it is always strict). Keep it dependency-free CommonJS: it must run
// both as `node file` and under `node -e`.
const hexKey = /^[0-9a-fA-F]{64}$/;
const errors = [];
const current = process.env.SECRET_ENCRYPTION_KEY || '';
const previous = process.env.SECRET_ENCRYPTION_KEY_PREVIOUS || '';
const optOut = process.argv.includes('--allow-plaintext-opt-out') && process.env.B4M_ALLOW_PLAINTEXT_SECRETS === 'true';
if (!hexKey.test(current)) {
  if (optOut) {
    console.error('WARNING: SECRET_ENCRYPTION_KEY is not a valid key and B4M_ALLOW_PLAINTEXT_SECRETS=true is set.');
    console.error('WARNING: stored secrets (API keys, tokens, admin settings) will be kept in PLAINTEXT. Evaluation only.');
    console.error('WARNING: set SECRET_ENCRYPTION_KEY to 64 hexadecimal characters (openssl rand -hex 32); see SELF_HOST.md.');
  } else {
    errors.push('SECRET_ENCRYPTION_KEY must be 64 hexadecimal characters (generate one with: openssl rand -hex 32). To run an evaluation install without encryption, set B4M_ALLOW_PLAINTEXT_SECRETS=true (Docker Compose only).');
  }
}
if (previous !== '' && previous !== 'not-configured' && !hexKey.test(previous)) {
  errors.push('SECRET_ENCRYPTION_KEY_PREVIOUS must be unset, empty, not-configured, or 64 hexadecimal characters.');
}
if (errors.length) { errors.forEach((message) => console.error('ERROR: ' + message)); process.exit(1); }
