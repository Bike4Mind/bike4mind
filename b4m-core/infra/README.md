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

Rotation records must refer to a registered contributed secret. They are merged into `getSecretRotationConfig()`
(`@bike4mind/server-utils/lib/secretRotation/constants`), which no longer drives a reminder since the in-app rotation
tracker was removed; the field is kept so existing package declarations stay valid.

A queue entry takes the `buildQueuePair` options (`name`, `visibilityTimeout`,
`dlqName`, `dlqVisibilityTimeout`, `retry`, `encryption`, ...) plus a `label`,
`displayName` and `application`. Queue and DLQ names are lowerCamel and used
verbatim as SST logical names; the DLQ defaults to `${name}DLQ`.
`visibilityTimeout` and the optional `dlqVisibilityTimeout` use the
`sst.aws.Queue` form (`'<n> seconds|minutes|hours'`, at most 12 hours); an unset
`dlqVisibilityTimeout` leaves the DLQ at the SQS default. The label is kebab-case and
names the DLQ alarm; `alarm-handler-dlq` is reserved. Unlike `buildQueuePair`, an
unset `encryption` means `'kms'`, so a queue moving here from `infra/queues.ts`
must state its current encryption to keep its resources. A pair is dropped whole
when either name (raw or env form) or its label collides with core, a reserved
variable, a contributed secret or an earlier declaration.

A queue entry may also carry the operator help a core registry entry shows on the
admin DLQ screens: `description` (one line on what the consumer does, at most 200
characters), `replay` (`'safe'`, `'side-effects'` or `'unsafe'`), `replayNote` (the
guard the replay value rests on, at most 400) and `owner` (an area name, never a
person, at most 64). Each text is a single trimmed line with no control characters.
An invalid value fails codegen, and a pair that still carries one is dropped whole.
Unset fields are left out of the registry entry.

A registered pair gets a DLQ alarm and dashboard widget, and is listed in the admin
DLQ registry. Only the web app is linked to it, and no consumer is subscribed: the
package must wire its own consumer.

`sst.config.ts` can hand a package's `contributeInfra` an infrastructure context:

- `contributedQueues`: the registered pairs, keyed by queue name with
  `{ spec, queue, dlq }` values.
- `eventBus`, `websocketApi`, `fabFileBucket`, `generatedImagesBucket`,
  `appFilesBucket` and `mcpHandler`: shared core resources to link or reference.
- `alarmTopic`: the DLQ alarm topic, undefined on a stage without monitoring.
- `mailBody`: `{ environment, permission }`, the environment entry and the IAM
  permission a function needs to offload large mail bodies to the app files bucket,
  as core queue subscribers get them.
- `forwardErrorLogs(logGroupName)`: subscribes a log group the package created to
  the core ERROR log handler (`infra/logMonitor.ts`). It takes the name as an SST
  input, such as `fn.nodes.logGroup.apply(lg => lg?.name)`, and does nothing under
  `sst dev` or for an undefined name.

Adding a key creates no resource. A package must treat each key as optional, since
a host revision that predates the wiring passes none of the newer ones.
Server code narrows its names with `contributedDlqLabel()` and
`contributedSourceQueueName()` from `@bike4mind/server-utils/utils/dlqRegistry` before
passing them to `getDlqUrl` or `getSourceQueueUrl`; both throw for a dropped or
undeclared name.

## DLQ registries

`createDlqRegistry` accepts `DlqDescriptor` entries with a non-null source queue.
Use `createInspectableDlqRegistry` and `InspectableDlqDescriptor` for a registry
that also includes inspection-only entries with `sourceQueue: null`. Those entries
still resolve their DLQ URL; source queue URL resolution accepts only non-null
source names. Replay-safety hints describe side effects separately from whether
a source destination exists.
