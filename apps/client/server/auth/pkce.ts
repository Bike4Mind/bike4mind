// RFC 7636 PKCE grammar, kept in a dependency-free leaf module so the request schemas at
// /oauth/code (challenge) and /oauth/token (verifier) and the verifyPkce predicate all validate the
// same shapes without importing oauthServer's heavier deps (Config, DB, RSA keys).
//
// code_verifier: 43-128 chars from the unreserved set [A-Za-z0-9-._~].
// S256 code_challenge: BASE64URL(SHA256(verifier)) - exactly 43 base64url chars, no padding.
export const PKCE_CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_S256_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
