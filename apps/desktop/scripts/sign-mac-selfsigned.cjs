// electron-builder `mac.sign` hook for the self-signed macOS release mode.
// electron-builder only picks identities that `security find-identity -v` calls valid, and a
// self-signed certificate never is, so the build passes `-c.mac.identity=-` to reach this hook.
// Everything else (entitlements, hardened runtime, inside-out order) is electron-builder's own.
const path = require('node:path');
const { createRequire } = require('node:module');

const builder = createRequire(require.resolve('electron-builder/package.json'));
const builderLib = createRequire(builder.resolve('app-builder-lib/package.json'));

module.exports = async function signWithStableCertificate(options) {
  const identity = process.env.B4M_MAC_SIGN_IDENTITY || '';
  const keychain = process.env.B4M_MAC_SIGN_KEYCHAIN || '';
  if (!/^[0-9a-f]{40}$/.test(identity)) {
    throw new Error('B4M_MAC_SIGN_IDENTITY must be the lowercase SHA-1 of the signing certificate');
  }
  if (!path.isAbsolute(keychain)) throw new Error('B4M_MAC_SIGN_KEYCHAIN must be an absolute keychain path');
  const { sign } = builderLib('./out/codeSign/macCodeSign');
  await sign({ ...options, identity, keychain, identityValidation: false });
};
