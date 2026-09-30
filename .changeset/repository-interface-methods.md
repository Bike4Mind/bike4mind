---
"@bike4mind/common": minor
---

Add required `removeMember` to `IOrganizationRepository` and `recordReferrals` to `IUserRepository`, a typed `RepositoryUpdateOptions<T>` for `IBaseRepository.update` and `updateMany`, and the exported `RepositoryPatch<T>` / `RepositoryUpdate<T>` types so `update` accepts dotted leaf paths (`'visual.portraitUrl'`). `updateMany` now honours the reserved `unset` option.
