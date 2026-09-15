---
"@bike4mind/services": major
"@bike4mind/slack": major
"@bike4mind/utils": major
---

resolve ingest file type by extension, with per-door precedence

**Breaking change.** `resolveSupportedMimeType`'s third parameter is now an options object instead of
a bare predicate function:

```ts
resolveSupportedMimeType(fileName, claimedMimeType, {
  isAcceptable?: (mimeType: string | null | undefined) => boolean; // defaults to isSupportedFabFileMimeType
  precedence?: 'extension-first' | 'claim-first'; // defaults to 'extension-first'
  extensionlessFallback?: SupportedFabFileMimeTypes;
})
```

A bare predicate passed as the third argument no longer works - wrap it as
`{ isAcceptable: yourPredicate }`. `precedence` controls whether the filename
extension or the caller-supplied MIME type is consulted first, and
`extensionlessFallback` is the type used for a filename that carries no
extension at all (and no claim) - omit it to keep a caller strict.

**Inputs that were previously accepted and are now refused:**

- A filename with a dot-tail that does not resolve to a known extension is
  refused outright - a claimed MIME type no longer rescues it. (`deploy.sh` or
  `malware.exe` claiming `text/plain` is no longer admitted.)
- A dotted date or version filename (`Meeting notes 2026.09.07`, `My Report
  v1.2`) is refused, because its tail is read as an unrecognized extension.
- A trailing-dot filename (`payload.`) is treated as malformed rather than
  extension-less, so it no longer receives a plain-text fallback.
- A URL import that yields no extractable text is now refused with an error
  instead of silently creating an empty file.
- The Slack ingest door now applies the same extension rule as the other
  ingest doors: an attachment whose filename has an unrecognized or
  date-style tail is refused.
