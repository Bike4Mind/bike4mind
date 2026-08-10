---
"@bike4mind/services": patch
---

`tagService.update`'s adapter no longer asks for `Pick<ITagRepository, 'update' | ...>`. Its
`tags.update` is now declared as the exact shape the service writes,
`TagUpdateParams & { updatedAt: Date }`. This is a relaxation, so every adapter that satisfied the
old type still satisfies the new one - but it is what lets an `IFileTag`-typed repository be passed
without a cast. `IBaseRepository` declares `update` as a property-syntax function type, so
`strictFunctionTypes` checks its parameter contravariantly and a `Partial<IBaseTag>` parameter
rejects a `Partial<IFileTag>` one on `TagType` vs `TagType.FILE`.

Behavioural note for anyone tracking the HTTP surface rather than the package: the caller of this
service, `PUT/DELETE /api/files/tags/[id]`, now takes the tag id from the URL on both verbs instead
of from the request body on PUT, and rejects a missing, empty or repeated URL id with a 400. That
route previously answered 422 (zod) for a repeated id and 404 (Mongoose `CastError`) for an empty
one. It lives in a private app package, so it has no changelog of its own; it is recorded here
because the route is reachable with an API key and an external consumer could have depended on the
old status codes.
