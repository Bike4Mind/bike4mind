# Infrastructure contributions

Workspace packages can declare secrets and rotation reminders as plain data in
their `package.json`:

```json
{
  "b4mContributions": {
    "infraResources": {
      "secrets": [{ "name": "EXAMPLE_API_TOKEN", "env": true }],
      "rotations": [
        {
          "secret": "EXAMPLE_API_TOKEN",
          "description": "External API token",
          "rotationIntervalDays": 90,
          "isAutomatic": false,
          "rotationProcess": "Rotate upstream, then update the SST secret"
        }
      ]
    }
  }
}
```

Run `node apps/client/scripts/generate-premium-glue.mjs` from the repository root
after changing declarations. It writes the same declarations for deployment and
server runtime use. Keep `infra/` present during generation; otherwise runtime
registration refuses contributions because it cannot check core name collisions.

Names must start with an uppercase letter and contain only uppercase letters,
digits and underscores. Core resource and environment names and reserved runtime
variables are dropped, and the first duplicate declaration wins. Dropped names
produce a warning. `env: true` also requires at least two characters, and exposes
the secret as a plain environment variable on the agent executor and chat service.
Secrets are linked to the web app as well. An unset secret uses `placeholder`, or
`not-configured` when omitted.

Server code reads a declared secret with
`readContributedSecret('EXAMPLE_API_TOKEN')` from
`@bike4mind/server-utils/utils/config`. An unlinked registered secret falls back
to the environment variable with the same name, supporting self-host deployments.
An unregistered name returns `undefined`. These checks prevent accidental
collisions; they do not sandbox workspace code.

Rotation reminders must refer to a registered contributed secret. The admin API
and notifier use `getSecretRotationConfig()` from
`@bike4mind/server-utils/lib/secretRotation/constants` to include them.

Before deactivating stale rotation records, regenerate the glue with every package
used by the target stage mounted. Preview the cleanup script with `--dry-run`,
then pass `--confirm-complete-rotation-inventory` to confirm that inventory for a
write. Use `--no-contributed-rotations` only when the stage has no contributed
rotations. Missing packages otherwise make live reminders appear stale.
