# Infrastructure contributions

Workspace packages can declare secrets, rotation reminders and queue/DLQ pairs as
plain data in their `package.json`:

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
      ],
      "queues": [
        {
          "name": "exampleJobQueue",
          "visibilityTimeout": "6 minutes",
          "label": "example-job-dlq",
          "displayName": "Example Job DLQ",
          "application": "example"
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

A queue entry takes the `buildQueuePair` options (`name`, `visibilityTimeout`,
`dlqName`, `retry`, `encryption`, ...) plus a `label`, `displayName` and
`application`. Queue and DLQ names are lowerCamel and used verbatim as SST logical
names; the DLQ defaults to `${name}DLQ`. `visibilityTimeout` uses the
`sst.aws.Queue` form (`'<n> seconds|minutes|hours'`). The label is kebab-case and
names the DLQ alarm; `alarm-handler-dlq` is reserved. Unlike `buildQueuePair`, an
unset `encryption` means `'kms'`, so a queue moving here from `infra/queues.ts`
must state its current encryption to keep its resources. A pair is dropped whole
when either name (raw or env form) or its label collides with core, a reserved
variable, a contributed secret or an earlier declaration.

A registered pair gets a DLQ alarm and dashboard widget, and is listed in the admin
DLQ registry. Only the web app is linked to it, and no consumer is subscribed: the
package must wire its own consumer. Server code narrows its names with
`contributedDlqLabel()` and `contributedSourceQueueName()` from
`@bike4mind/server-utils/utils/dlqRegistry` before passing them to `getDlqUrl` or
`getSourceQueueUrl`; both throw for a dropped or undeclared name.

Before deactivating stale rotation records, regenerate the glue with every package
used by the target stage mounted. Preview the cleanup script with `--dry-run`,
then pass `--confirm-complete-rotation-inventory` for a write, or
`--no-contributed-rotations` when the stage has no contributed rotations. The flags
are not the safeguard. Run under `sst shell`, the script also checks the stage: it
refuses when a stale record names a non-core secret that the stage still deploys,
because that record belongs to a package missing from the local tree. It also
refuses when the shell does not link every core secret (as under `sst shell
--target`), and when the glue was generated without `infra/`, since core and
package names cannot then be told apart.
