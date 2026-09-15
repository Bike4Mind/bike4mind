# Vendored Scalar API Reference bundle

`scalar.standalone.js` is the self-contained [Scalar API Reference](https://github.com/scalar/scalar)
browser bundle, served by `GET /api/v1/docs` to render the OpenAPI spec at `/api/v1/openapi.json`.

It is vendored (committed here) rather than hot-linked from a CDN so the docs page has no
third-party runtime dependency: no external script host to trust, no supply-chain or CSP exposure
on a public deployment. The `/api/v1/docs` route serves it from this same origin under a scoped CSP.

## Pin

- Package: `@scalar/api-reference`
- Version: `1.63.0`
- License: MIT (banner retained at the top of the file)
- SHA-256: `afeab434b10be322e56cec6354107be6aa9345ebc2b6dac2d438c0b5a7da5cc8`

## How to update

Re-fetch the pinned version, verify the license banner, and update the version + SHA-256 above:

```bash
VERSION=1.63.0   # bump to the target release
curl -sL "https://cdn.jsdelivr.net/npm/@scalar/api-reference@${VERSION}/dist/browser/standalone.js" \
  -o apps/client/public/scalar/scalar.standalone.js
shasum -a 256 apps/client/public/scalar/scalar.standalone.js
```

The docs page disables Scalar's default hosted fonts (`withDefaultFonts: false`) so the bundle makes
no outbound font request; keep that config if you bump the version.
