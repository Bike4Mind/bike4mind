CONSTRUCTED: ListFoundationModels and GetFoundationModelAvailability need IAM
credentials for a Bedrock-enabled account, and the only AWS credential on this
machine is the local MinIO one (which is exactly the case DiscoveryCredentials
.awsIam exists to refuse). Field names, nesting and enum spellings are taken
verbatim from the typed FoundationModelSummary, FoundationModelLifecycle and
GetFoundationModelAvailabilityResponse in @aws-sdk/client-bedrock 3.1080.0
(dist-types/models/models_1.d.ts), which is the version this monorepo already
resolves. Model ids, provider names and modality pairs are the real ones.

Timestamps are ISO strings here rather than Date objects: the SDK hands back
Dates, and the parser must accept both, because a driver that serializes the
response through a queue delivers strings.
