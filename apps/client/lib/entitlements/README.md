# Contributed entitlement rows

An overlay package can declare literal `b4mContributions.entitlementGrants` data in
its `package.json`. For example:

```json
{
  "b4mContributions": {
    "entitlementGrants": {
      "tagGrants": [{ "tag": "example-pro", "entitlements": ["example:pro"] }],
      "impliedEntitlements": [{ "ifHeld": "example:pro", "alsoGrant": ["example:addon"] }],
      "internalStaffEntitlements": ["example:staff"],
      "signupCredits": [{ "key": "example:staff", "credits": 1000 }]
    }
  }
}
```

Run `pnpm --filter @bike4mind/client codegen` after changing the declaration.
The generator validates the data and writes
`apps/client/app/premium-generated/premiumEntitlementGrants.generated.ts`.
The registry imports this data without importing overlay code. With no overlay,
the generated contribution is `{}`.

Keys and tags must be lowercase, trimmed strings matching
`[a-z0-9][a-z0-9:_-]*`. `base`, `customer`, `pending-free-credits`, and the
`datalake:`, `embed:`, and `source:` prefixes are reserved. Lists cannot be empty.
Contributions must add new territory: built-in tags and keys, including keys
configured through price and external-domain rows, remain owned by core.

Implications must be reachable from a contributed tag grant or staff key; chains
and grounded cycles are supported. Signup credits must use a contributed staff
key and be whole numbers from 1 through 250000. The staff-domain grant applies to
verified email addresses on `NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS`, including domains also
listed in `NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS`. Existing external grants remain
intact. Signup credits use the existing one-time signup-domain grant path; a
matching database partner rule takes precedence over that registry fallback.

Accepted keys appear in the entitlement catalog, admin Product Access, and
partner-rule validation. A tag-granted key has a Product Access grant/revoke
toggle; implied and staff-only keys do not acquire their own toggle.

## Troubleshooting

- Codegen fails on malformed data, conflicting declarations, or multiple explicit
  granting tags for one key. Fix the named package declaration and rerun codegen.
- If a key is missing after codegen succeeds, check application logs for
  `[entitlements] dropped contributed registry rows`. Runtime merging rejects
  collisions with built-in and environment-derived keys that codegen cannot see.
- If staff access is missing, check the staff-domain configuration and email
  verification status. If access exists but signup credits are absent, check for
  a matching database partner rule or an already-applied one-time credit grant.
