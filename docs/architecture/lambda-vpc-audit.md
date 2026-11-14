# Lambda VPC audit

Audit of every Lambda handler declared under `infra/`: what it reaches, and whether it has to run inside the VPC. A VPC-attached Lambda sends all public traffic through the NAT, so each one that does not need a private route adds NAT data cost and ties its availability to the NAT for nothing.

The `frontend` Next.js function (`infra/web.ts`) is out of scope and stays attached.

## What is private in this stack

A Lambda needs the VPC only to reach one of these:

| Resource | Why it needs the VPC route | Where |
|---|---|---|
| MongoDB | The database is reached over the VPC's egress path. Deployments allow the cluster either by the NAT address or by VPC peering (`docs-site/docs/deployment/prerequisites.md`), and DocumentDB is VPC-only. A Lambda outside the VPC has neither. | `MONGODB_URI`, `connectDB` |
| SearXNG | Private Cloud Map name; its security group admits callers from inside the VPC only. | `infra/searxng.ts` |
| ChatCompletion `/process` | The load balancer admits the internal dispatch from the NAT address only. | `infra/chatCompletion.ts` |

S3, SQS, EventBridge, Bedrock, SES, CloudWatch, Secrets Manager, the API Gateway management endpoint and the external provider APIs are all public endpoints and need no VPC.

## Decision rule

Remove `vpc` only where the handler provably reaches none of the three resources above, directly or through code it imports. If in doubt, keep.

## Method

Each handler was bundled with esbuild from its entry file (the same resolution the deploy uses) and the bundle's module graph and text were checked for the MongoDB driver, `connectDB`, and the two in-VPC URLs. Handlers whose graph contains the driver were then confirmed to connect: either the entry file uses the database directly, or it is wrapped by `dispatchWithLogger`, `withEventContext`, `withWebSocketContext` or `defineLambdaRoute`, which all call `connectDB` before the handler body runs.

## Result

Counts are as of this audit; the table below is the current record and is checked against `infra/` by `infra/__tests__/lambdaVpcAudit.test.ts`.

150 handlers were declared. 144 were VPC-attached before this change.

- **2 detached**: `ImageProcessor` and the WebSocket `heartbeat` route.
- **142 stay attached**: 137 connect to MongoDB, 4 could not be traced because their source is not in this repository, and 1 (`mcpHandler`) reaches nothing private but is kept for the reason below.
- **6 were already outside the VPC** and are listed for completeness.

The issue's premise that most Lambdas reach only public managed services does not hold for this codebase: nearly every handler opens the database, and the database is the private resource. The larger saving is therefore not in detaching more Lambdas but in the endpoint work below, or in a database access path that does not depend on the VPC.

### Kept although no private resource was found

`mcpHandler` (`infra/mcp.ts`) opens no database and calls only public connector APIs. Detaching it would move those outbound calls from the fixed NAT address to the Lambda service's shared address range. Whether anything depends on that fixed address (a third-party allowlist, for example) cannot be established from the repository, so it stays. It is the one remaining candidate.

## Gateway endpoints

`infra/vpc.ts` now adds Gateway VPC endpoints for S3 and DynamoDB to the private route tables **when the stack provisions its own VPC** (`VPC_ID` unset). Gateway endpoints have no hourly or data charge.

When `VPC_ID` is set the VPC is shared by several stages and owned outside this stack. A route table takes one gateway endpoint per service, so each stage adding its own would fail on the second deploy. For a shared VPC, add the two gateway endpoints once, where the VPC itself is defined.

A stack-provisioned VPC that already has an S3 or DynamoDB gateway endpoint added by hand on its private route tables will fail to deploy this change with a route conflict. Remove the hand-added endpoint first.

Interface endpoints (SQS, Secrets Manager, Bedrock) are not added. Each costs an hourly charge per AZ plus a per-GB charge, so they pay off only where the NAT data they displace is larger. Decide that from the NAT measurement below.

## Measurement (pending)

Not measured here; both need a deployed stage.

- **Cold start**: in CloudWatch Logs Insights over the function's log group, before and after the deploy: `filter @type = "REPORT" and ispresent(@initDuration) | stats pct(@initDuration, 50), pct(@initDuration, 99), count()`. The two detached functions are the ones to compare.
- **NAT data**: `AWS/NATGateway` metric `BytesOutToDestination` (Sum, 1 day) for the stage's NAT gateway, for a week either side of the deploy. A stack that provisions its own VPC uses an EC2 NAT instance instead, where the equivalent is the instance's `NetworkOut`.

## Per-Lambda table

"Linked" lists the resources the declaration passes in `link`. `allSecrets` includes `MONGODB_URI`.

The four handlers declared in `infra/queues.ts` whose source is generated outside this repository are not listed. They could not be traced and all stay attached.

| Handler | Declared in | Reaches | VPC required | Justification |
|---|---|---|---|---|
| `apps/workers/src/cron/adminMorningBrief.handler` | `infra/adminMorningBrief.ts` | MongoDB; linked: `allSecrets` | Yes | Reads and persists morning brief facts and delivery claims in MongoDB. |
| `apps/client/server/websocket/agentExecute.func` | `infra/agentExecutor.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `agentExecutor` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/ccAgentDisconnect.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/ccAgentEvent.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/ccAgentRegister.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/cliToolExecution.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/connect.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/dataSubscribeRequest.func` | `infra/subscriberFanout.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/dataUnsubscribeRequest.func` | `infra/subscriberFanout.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/default.handler` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Dispatches `keep_command_*` to handlers that authenticate against MongoDB. |
| `apps/client/server/websocket/disconnect.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/heartbeat.func` | `infra/websocket.ts` | linked: `allSecrets`, `websocketApi` | No | Removed in this change. Runs with `skipDatabase`; its only call is PostToConnection on the public API Gateway management endpoint. |
| `apps/client/server/websocket/jupyterNotebookProgress.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/keepCommandRequest.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/keepCommandResponse.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/reauthConnection.func` | `infra/subscriberFanout.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/voiceSessionEnded.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/client/server/websocket/voiceSessionSendTranscript.func` | `infra/websocket.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/cli/tools.handler.handler` | `infra/cliToolHandler.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/abuseAssessmentSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/accountCampaignSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/accountCreationMetrics.handler` | `infra/accountCreationAlarms.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/accountDeletionSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `eventBus`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `historyImportBucket`, `publishedArtifactsBucket`, `routerDistributionId` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/adminAuditAlerts.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/agentExecutionAbandonedSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/agentProactiveMessaging.checkAndScheduleProactiveMessages` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `agentProactiveMessageQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/analyticsRollup.handler` | `infra/analyticsRollup.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/apiKeyBaselineCalculation.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/apiProbeDetector.handler` | `infra/apiProbeDetector.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/businessMetricAlerts.handler` | `infra/businessMetricAlerts.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/completionSequenceSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/creditHoldSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/creditLotSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/creditPurchaseReconciliation.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/dataLakeBatchReconcile.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `dataLakeTaxonomyQueue`, `websocketApi`, `fabFileChunkQueue`, `fabFileBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/dataLakeResearchSchedule.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `dataLakeResearchQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/dataLakeVectorIndexKeepWarm.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/deepAgentWake.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `deepAgentWakeQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/disposableDomainRefresh.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/driveLakeResyncPoll.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `driveLakeIngestQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/emailCampaignScheduler.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `emailJobQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/generationJobSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `generationJobQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/githubLakeReconcile.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `githubLakeIngestQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/helpDatalakeIngest.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/imageModerationReviewSweep.handler` | `infra/imageModerationReviewSweep.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/integrationHealthCheck.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/lakeConnectorOrphanReap.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `githubLakeRevokeQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/lakeHealthSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/lakeInconsistencySweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/liveopsTriageDispatcher.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `liveOpsTriageQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/liveopsTriageWorker.handler` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `eventBus`, `mcpHandler` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/modelDiscovery.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/modelDiscoveryStaleness.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/oauthAbuseAutoBlock.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/organizationRetention.handler` | `infra/organizationRetention.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `routerDistributionId` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/providerUsagePoll.handler` | `infra/cron.ts` | linked: `allSecrets` | No | Already outside the VPC. Provider usage APIs and CloudWatch only. |
| `apps/workers/src/cron/questTimeoutSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `generationCallbackQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/realtimeConnectionSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/referralRewardRelease.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/revenueSnapshot.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/scheduler.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `researchEngineQueue`, `fabFileBucket`, `generatedImagesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/secopsTriageWorker.handler` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/secretRotationNotifier.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/securityScanScheduler.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/signupBaselineReport.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/signupDomainHoldTriage.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/signupGrantHeldRelease.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/signupIpRetention.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/personaExpirySweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/signupRiskSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets`, `riskEvidenceQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/skillMarketReviewSla.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/spendMonitor.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/spendReconciliation.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/sreStaleDispatch.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/storageReconciliation.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/subscriptionReconciliation.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/telemetryCleanup.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/usagePatternSignals.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/userActivityReport.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/voiceHoldSweep.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/cron/youngAccountSpendAlert.handler` | `infra/youngAccountSpendAlert.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/database/dropPreviewDatabase.handler` | `infra/database.ts` | MongoDB; linked: `secrets.MONGODB_URI` | Yes | Connects to MongoDB. |
| `apps/workers/src/database/manageDatabase.updateDatabase` | `infra/database.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/database/seedDatabase.handler` | `infra/database.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/deepAgent/wakeHandler.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/emailIngestion/emailAnalyzer.dispatch` | `infra/emailIngestion.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `fabFileBucket`, `generatedImagesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/emailIngestion/emailParser.dispatch` | `infra/emailIngestion.ts` | MongoDB; linked: `allSecrets`, `emailIngestionBucket`, `emailIngestionQueue`, `emailAnalysisQueue`, `fabFileBucket`, `generatedImagesBucket`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/createMemento.handler` | `infra/llm.ts` | MongoDB; linked: `allSecrets`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/dlqAlarmToSlack.handler` | `infra/dlqAlarms.ts` | linked: `secrets.SLACK_ERROR_REPORTING_WEBHOOK_URL`, `secrets.SLACK_ALARMS_WEBHOOK_URL`, `secrets.SLACK_COST_ALARMS_WEBHOOK_URL` | No | Already outside the VPC. SNS alarm to Slack relay. |
| `apps/workers/src/events/logToSlack.ingest` | `infra/logMonitor.ts` | MongoDB; linked: `allSecrets`, `sreJobQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/notebookCuration.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `notebookCurationQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/notebookCurationAnalytics.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/sendEmail.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/sendPush.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/serviceHealthAlarmToSlack.handler` | `infra/serviceHealthAlarms.ts` | linked: `secrets.SLACK_ERROR_REPORTING_WEBHOOK_URL`, `secrets.SLACK_ALARMS_WEBHOOK_URL`, `secrets.SLACK_COST_ALARMS_WEBHOOK_URL` | No | Already outside the VPC. SNS alarm to Slack relay. |
| `apps/workers/src/events/sessionAutoNaming.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/sessionContextSummarization.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/sessionSummarization.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/sessionTagging.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/spider.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/stripe/customerSubscriptionUpdated.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/stripe/invoicePaymentSucceeded.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/studioJobCompleted.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/telemetryAlert.handler` | `infra/eventBus.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/events/wafAlarmToSlack.handler` | `infra/waf.ts` | linked: `secrets.SLACK_ERROR_REPORTING_WEBHOOK_URL`, `secrets.SLACK_ALARMS_WEBHOOK_URL`, `secrets.SLACK_COST_ALARMS_WEBHOOK_URL` | No | Already outside the VPC. SNS alarm to Slack relay. |
| `apps/workers/src/jobs/dataSyncerHandler.handler` | `infra/dataSyncer.ts` | MongoDB; linked: `secrets.MONGODB_URI` | Yes | Connects to MongoDB. |
| `apps/workers/src/mcp/mcpCall.handler` | `infra/mcp.ts` | linked: `secrets.RATE_LIMIT_INGEST_TOKEN` | Yes (kept, not required by a private resource) | Opens no database and reaches only public connector APIs, but those calls currently leave from the fixed NAT address. Kept until an owner confirms nothing depends on that address. |
| `apps/workers/src/mcp/remoteMcpCall.handler` | `infra/remoteMcp.ts` | none | No | Already outside the VPC by design: calls user-supplied hosts, so it must hold no private route. |
| `apps/workers/src/media/imageProcessor.handler` | `infra/imageProcessor.ts` | linked: `allSecrets`, `generatedImagesBucket`, `appFilesBucket`, `fabFileBucket` | No | Removed in this change. Pure compute: image arrives in the invoke payload and is returned in the response; no database, no network call. |
| `apps/workers/src/media/publishThumbnailRenderer.handler` | `infra/queues.ts` | none | No | Already outside the VPC by design: renders untrusted documents with no credentials and no private route. |
| `apps/workers/src/queueHandlers/accountDataExport.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/accountErasure.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `eventBus`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `historyImportBucket`, `publishedArtifactsBucket`, `routerDistributionId` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/agentExecutor.handler` | `infra/agentExecutor.ts` | MongoDB; SearXNG (in-VPC, where deployed); linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `websocketApi`, `mcpHandler`, `remoteMcpHandler`, `eventBus`, `imageProcessor`, `agentContinuationQueue`, `generationJobQueue` | Yes | Connects to MongoDB and calls the in-VPC SearXNG service. |
| `apps/workers/src/queueHandlers/agentProactiveMessage.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/dataLakeCleanup.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `githubLakeRevokeQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/dataLakeResearchRun.dispatch` | `infra/queues.ts` | MongoDB; SearXNG (in-VPC, where deployed); linked: `allSecrets` | Yes | Connects to MongoDB and calls the in-VPC SearXNG service. |
| `apps/workers/src/queueHandlers/dataLakeTaxonomyAnalysis.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/driveDisconnectPurge.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `driveDisconnectPurgeQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/driveLakeIngest.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `driveLakeIngestQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/emailBatch.dispatch` | `infra/emailMarketing.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/emailJobOrchestrator.dispatch` | `infra/emailMarketing.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `emailBatchQueue`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/fabFileChunk.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `fabFileVectorizeQueue`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `dataLakeTaxonomyQueue`, `lakeMemoryQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/fabFileVectorize.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `dataLakeTaxonomyQueue`, `lakeMemoryQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/generatedMediaPurge.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `generatedImagesBucket`, `routerDistributionId`, `generatedMediaPurgeQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/generationCallback.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `generatedImagesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/generationJob.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `generatedImagesBucket`, `fabFileBucket`, `appFilesBucket`, `eventBus`, `generationCallbackQueue`, `generationJobQueue`, `imageProcessor` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/githubLakeIngest.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `githubLakeIngestQueue`, `githubLakeRevokeQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/githubLakeRevoke.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `githubLakeRevokeQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/githubWebhook.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `mcpHandler` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/imageEdit.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `generatedImagesBucket`, `fabFileBucket`, `appFilesBucket`, `imageProcessor`, `eventBus`, `generationCallbackQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/imageGeneration.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `generatedImagesBucket`, `fabFileBucket`, `appFilesBucket`, `imageProcessor`, `eventBus`, `generationCallbackQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/lakeInconsistencyModelDetection.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/lakeMemoryExtraction.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `lakeMemoryQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/notebookCuration.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `eventBus`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/publishThumbnail.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `publishedArtifactsBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/questExport.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/researchEngineQueue.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `websocketApi`, `generatedImagesBucket`, `researchEngineQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/riskEvidence.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `riskEvidenceQueue` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/slackExport.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `slackExportBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/slackQuestProcessor.handler` | `infra/functions.ts` | MongoDB; SearXNG (in-VPC, where deployed); linked: `allSecrets`, `fabFileBucket`, `generatedImagesBucket`, `appFilesBucket`, `websocketApi`, `mcpHandler`, `eventBus`, `imageProcessor`, `generationJobQueue` | Yes | Connects to MongoDB and calls the in-VPC SearXNG service. |
| `apps/workers/src/queueHandlers/sreFix.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/sreJob.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `sreFixQueue`, `eventBus` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/webhookDelivery.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/whatsNewHighlights.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/queueHandlers/whatsNewJob.dispatch` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/s3/appFileUploadComplete.func` | `infra/buckets.ts` | MongoDB; linked: `allSecrets`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/s3/historyUploadComplete.dispatch` | `infra/buckets.ts` | MongoDB; linked: `allSecrets`, `historyImportBucket`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/s3/notebookImportComplete.dispatch` | `infra/buckets.ts` | MongoDB; linked: `allSecrets`, `fabFileBucket`, `appFilesBucket`, `generatedImagesBucket`, `historyImportBucket`, `websocketApi` | Yes | Connects to MongoDB. |
| `apps/workers/src/s3/objectCreated.func` | `infra/queues.ts` | MongoDB; linked: `allSecrets`, `websocketApi`, `fabFileChunkQueue`, `fabFileBucket` | Yes | Connects to MongoDB. |
| `apps/workers/src/security/alertProcessor.handler` | `infra/securityAlerts.ts` | MongoDB; linked: `eventBus`, `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/security/attackSimulation/runner.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
| `apps/workers/src/security/cloudScan.handler` | `infra/cron.ts` | MongoDB; linked: `allSecrets` | Yes | Connects to MongoDB. |
