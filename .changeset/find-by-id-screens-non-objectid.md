---
"@bike4mind/db-core": minor
"@bike4mind/database": minor
---

`BaseRepository.findById` now resolves `null` for a string that is not an ObjectId instead of
handing it to Mongoose and rejecting with a `CastError`, and it reports a row-not-found as `null`
rather than `undefined`. The single-id lookups on `SharableDocumentModel`
(`findAccessibleById`, `findUpdateAccessById`, `findShareAccessById`) and the `findById*`
variants on Session, ImportHistoryJob, IdentityProvider, ResearchAgent, ResearchData and Quest
follow the same contract.

Wire effect: routes that hand a caller-supplied path or query id to one of these now answer the
404 from their own `if (!doc) throw new NotFoundError(...)`. The status a caller sees for a
malformed id is unchanged (`404`) - it previously came from the API error handler's
`CastError path === '_id'` remapping - but it is now attributable to the route rather than to a
middleware rule that cannot tell a caller's junk id from a server-side cast. A caller narrowing
a miss with `=== undefined` instead of a falsy check will stop matching.

Two list routes do change their answer, for the better: `mementos` and `organizations/stats` build
an `_id: { $in: [...] }` from caller-supplied ids, where a single uncastable entry rejected the
whole query and surfaced as a `404` for the entire list. They now drop the unusable entries and
return the valid rows (`200`). An all-invalid list emits `$in: []`, so nothing widens to
"everything", and each route keeps its own ownership filter.

Not changed: `BaseRepository.update` and `delete` still address the row with `convertId`, which
calls `new Types.ObjectId(id)` and throws a `BSONError` - not a `CastError`, so the error
handler's cast remap never applied to them and they answer `500` for a malformed id both before
and after this change. Converging them needs its own decision about what an unaddressable id
should mean on a write (a no-op result, or a thrown not-found), so it is deliberately out of
scope here rather than overlooked.
