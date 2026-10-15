# Kubernetes self-host package

This independent Helm chart packages the current main application and workers. It does not use the older Kubernetes prototype. It is an evaluation deployment, not a claim that every application workflow or production requirement has been proven. Kubernetes may run locally, on another provider, or on EKS. The application's configured S3, queue and model providers can remain external during an incremental migration.

The default stack runs app, chatcompletion, background worker, WebSocket gateway, subscriber fanout, MongoDB, MinIO, ElasticMQ and Mailpit. Agent execution is opt-in. Model serving, search and image generation are configured endpoints, not workloads installed by this chart. Mailpit catches outgoing email; it does not replace incoming SES email processing or deliver transactional mail.

## Prerequisites

- Kubernetes 1.27 or newer, Helm 3.19 or newer, and a working default storage class, or `storage.className` explicitly set to an available class.
- A trusted evaluation namespace. MongoDB and ElasticMQ have no authentication here. ClusterIP services have no public ingress, but other workloads in the cluster can reach them unless the cluster's network policy prevents it. Do not expose backing services publicly. TLS, authenticated database operation, ingress and backup/restore are separate production work.
- A registry reachable by every node, including credentials in `imagePullSecrets` if needed. All application images must come from the same source revision. Tagged references and digests are accepted; untagged images and `:latest` are rejected. For repeatable tests and rollback, use digests or immutable tags.
- Available PVC capacity: 10 GiB MongoDB, 20 GiB object storage and 5 GiB queues by default. Configure sizes before creating PVCs. Single replicas and ReadWriteOnce storage provide no high availability.

## Build and pin images

Build application images on a remote builder with sufficient memory, not on a laptop running the cluster. The Next.js app source build can require substantial memory. Push images for every node architecture used by the cluster. The chart does not build or publish images.

| Values key                | Dockerfile                                       | Build context         |
| ------------------------- | ------------------------------------------------ | --------------------- |
| `images.app`              | `Dockerfile`                                     | repository root       |
| `images.chatcompletion`   | `apps/client/Dockerfile.chatcompletion.selfhost` | repository root       |
| `images.ws`               | `selfhost/ws-gateway/Dockerfile`                 | `selfhost/ws-gateway` |
| `images.minio`            | `selfhost/minio/Dockerfile.minio`                | `selfhost/minio`      |
| `images.mc`               | `selfhost/minio/Dockerfile.mc`                   | `selfhost/minio`      |
| `agentExecutor.image`     | `apps/client/Dockerfile.agentexecutor.selfhost`  | repository root       |
| `images.subscriberFanout` | published image from its separate repository     | not built here        |

The Kubernetes initializer requires the mc image built from this revision, including jq for exact lifecycle policy reconciliation. Do not reuse an older mc image without jq. Existing unrelated lifecycle policies are preserved; each required prefix and expiration is reconciled independently.

The background worker reuses the chatcompletion image with the current `apps/workers` entrypoint. Build MinIO and mc using the pinned upstream source recipes above; there is no implicit fallback to a pull-only MinIO tag. See [object storage provenance](../minio/README.md).

Copy `images.example.yaml` outside the checkout and replace all registry placeholders with the images you built and pushed. The bundled database, queue and mail image defaults are pinned. Review any upgraded upstream release before changing its reference. Keep the values file and source revision with the deployment's validation evidence.

## Install

1. Select the intended Kubernetes context. Use a new namespace so this deployment does not modify another self-host stack.

   ```sh
   kubectl config current-context
   kubectl create namespace bike4mind-eval
   ```

2. Copy `runtime.env.example` outside the checkout, restrict it to mode 600, and generate separate secrets. `SECRET_ENCRYPTION_KEY` must be 64 hexadecimal characters. Signing and internal authentication secrets must have at least 32 characters. The MinIO password must have at least 16 characters. For local MinIO, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` equal its username/password; they are compatibility credentials, not AWS account credentials. Do not rotate the encryption key without preserving `SECRET_ENCRYPTION_KEY_PREVIOUS` for existing ciphertext.

   ```sh
   kubectl create secret generic bike4mind-runtime \
     --namespace bike4mind-eval --from-env-file=/secure/path/runtime.env
   ```

   Use an existing Kubernetes Secret or your cluster's secret manager integration. This chart never creates a Secret or accepts credentials in values. Do not use the full Compose `.env.selfhost.example` as the Secret unchanged: its short Compose service endpoints would override the release-prefixed Kubernetes configuration.

3. Set public URLs in your values file to the origins browsers and CLI clients will actually use. The defaults match the port-forwards below. Set image references, optional image pull secrets and storage class. Release names must contain at most 35 characters.

4. Render and install using the same namespace and release name. Initialization is an ordinary Job, not a Helm hook. Headless Mongo DNS publishes the unready pod so the pre-start guard can resolve itself. The guard requires two consecutive answers containing only the current pod IP before MongoDB starts; it times out after 300 seconds by default. Mongo startup then initializes or verifies the single-node replica set and waits for PRIMARY. A stored member address is never silently reconfigured.

   ```sh
   helm template b4m selfhost/kubernetes --namespace bike4mind-eval \
     -f /secure/path/images.yaml > /tmp/b4m-rendered.yaml
   kubectl apply --dry-run=server --namespace bike4mind-eval -f /tmp/b4m-rendered.yaml
   helm upgrade --install b4m selfhost/kubernetes --namespace bike4mind-eval \
     -f /secure/path/images.yaml --wait --wait-for-jobs --timeout 15m
   kubectl get pods,pvc,jobs --namespace bike4mind-eval
   ```

   App and workers wait for Mongo PRIMARY and a successful storage initialization marker. The initializer creates the seven configured buckets, upload notification registrations and current Compose lifecycle policies, then writes the marker. It is safe to rerun. Its deterministic name changes when chart initialization inputs or values change, avoiding immutable Job updates. Change `initializationRevision` when an existing Secret's contents change or an explicit rerun is needed. Do not delete PVCs to retry initialization.

5. Open four separate terminals for the browser-facing services. The chatcompletion port serves the CLI/API SSE endpoint. Keep these loopback-bound port-forwards private.

   ```sh
   kubectl port-forward --namespace bike4mind-eval svc/b4m-app 3000:3000
   kubectl port-forward --namespace bike4mind-eval svc/b4m-ws 3001:3001
   kubectl port-forward --namespace bike4mind-eval svc/b4m-chatcompletion 8788:8080
   kubectl port-forward --namespace bike4mind-eval svc/b4m-minio 19000:9000
   ```

   The MinIO API forward matches `config.S3_PRESIGN_ENDPOINT` for QuestMaster ZIP downloads. Backend storage traffic keeps the private service endpoint. For remote browsers, set this value to a trusted HTTPS S3 API origin serving the same buckets; preserve the signed host, path and query through any proxy.

   Open `http://localhost:3000`. Read test email by forwarding deployment/b4m-mail port 8025. Mailpit's UI port is intentionally absent from its Service.

## Configuration and mixed providers

Non-secret defaults come from a ConfigMap. `config` values override those defaults. The existing Secret is loaded after the ConfigMap, so explicit Secret endpoint/provider settings override configuration. MongoDB uses an explicit reference: local mode reads `MONGODB_URI` from the ConfigMap, while external mode reads it from the Secret. Authentication keys always refer to required Secret keys. These values are shared across application roles; the gateway also gets its private application endpoint explicitly.

To retain an external S3-compatible backend, set `AWS_ENDPOINT_URL_S3`, bucket names and compatible credentials for the application. Queue and model endpoints can similarly point outside the namespace. MinIO, ElasticMQ and Mailpit remain local; MongoDB is omitted when external Mongo mode is enabled. The storage initializer and marker check always target the private chart MinIO service; they never initialize or modify external S3 buckets. Provision external buckets, lifecycle and notification delivery separately before selecting them. Do not interpret a healthy local backing service as proof that the selected external provider works.

Queue declarations and environment names mirror root `elasticmq.conf` and `.env.selfhost.example`; tests reject drift. Configuring a queue does not prove its consumer's outcome. The WebSocket gateway and scheduler worker remain singleton deployments with `Recreate`, since their state/leases do not justify unrestricted scaling. No ArgoCD, AWS-specific storage class, load balancer or administrative tunnel is installed.

For agent execution, set `agentExecutor.enabled: true`, supply the matching source-built image, and add `AGENT_EXECUTOR_INTERNAL_SECRET` to the Secret. App and executor validate it before starting. Executor termination allows 14 minutes; chatcompletion allows 150 seconds and the background worker 30 seconds.

## Restart and rollback

- Record the exact source/image references and `helm get values b4m -n bike4mind-eval` before upgrading. Never include secret values in receipts.
- Upgrade with the same release/namespace and reviewed values. Local mode now ignores a `MONGODB_URI` left in the runtime Secret: an install that used that key to reach an external database must set `externalMongo.enabled: true` (with `config.MONGODB_URI` unset) to keep using it. PVCs retain MongoDB, object and queue data. App deployments use `Recreate`; transient interruption is expected. Changing Secret contents does not restart pods automatically. After a reviewed Secret update, bump `initializationRevision` and run the same upgrade command.
- For a restart proof, record a signed-in user's ID, recreate Mongo and app pods, wait for PRIMARY/readiness and sign in again. Check unchanged PVC identities and the same user. This proves persistence for that case, not full restore or host-loss recovery.
- Inspect `kubectl logs -n bike4mind-eval pod/<mongo-pod> -c wait-member-dns` for DNS guard failures. Confirm the advertised member DNS resolves only to its current IP. An existing replica-set configuration mismatch fails closed; investigate it rather than deleting database storage or silently reconfiguring it.
- Roll back image/config-only releases with `helm history` and `helm rollback b4m <revision> -n bike4mind-eval --wait --timeout 15m`. Rollback does not reverse database migrations, bucket changes or Secret rotation. Keep compatible previous images and backups before upgrades that change persisted data.
- `helm uninstall` leaves the three PVCs because of their retention annotations. Reinstallation requires explicit ownership/adoption of retained claims; do not assume a clean install will adopt them. Delete claims only after independently deciding their data can be discarded.

## Local package checks

```sh
# Install jq using your operating system package manager.
jq --version
python3 -m pip install PyYAML==6.0.2
python3 -m unittest discover -s selfhost/kubernetes/tests
helm lint selfhost/kubernetes -f selfhost/kubernetes/images.example.yaml
helm lint selfhost/kubernetes -f selfhost/kubernetes/images.example.yaml -f selfhost/kubernetes/external-mongo.example.yaml
```

Tests render the real chart, reject duplicate YAML keys and unsafe configuration, validate current worker/drain/persistence contracts, isolate mixed S3 initialization, verify deterministic Job reruns, and exercise the actual DNS guard with missing/stale/mixed/current IPv4 and IPv6 resolver answers. Runtime acceptance still requires a fresh cluster installation, authenticated signup/session and ticket-based WebSocket checks, idempotent object setup, queue inventory, and persistence after Mongo/app recreation. Full chat, agent, import, schedule outcomes and production recovery remain separate parity work.

## External MongoDB

Local MongoDB remains the default. To prepare an Atlas deployment, combine the normal image values with `external-mongo.example.yaml`. Create the runtime Secret separately with all required runtime keys plus `MONGODB_URI`. The chart requires that key explicitly and rejects a URI in config values when external MongoDB is enabled. No credential belongs in Git, Helm values, or command arguments.

External mode omits the local MongoDB StatefulSet, Service, PVC, default URI, and DNS guard. Its startup check reads the URI from the environment, requires a writable primary, and never initializes or changes the external replica set. Each of 60 attempts is limited to 15 seconds, with a further 5 seconds to force termination, even when the URI specifies unlimited timeouts. Existing timeout options are preserved; defaults are added only for missing options. Connection output is suppressed and failures emit only fixed, credential-free reason names. Use Atlas TLS verification without insecure URI options, a dedicated evaluation database and least-privilege database user, and an Atlas network allowlist matching the cluster's actual outbound addresses. This chart does not manage Atlas access, backups, or migration. Switching an existing local installation does not migrate its data; preserve its retained PVC and migrate separately. Disabling external mode restores the ConfigMap URI even if the Secret still contains an external URI; it does not copy external data into local MongoDB.

MinIO and ElasticMQ remain local and require persistent storage (20Gi and 5Gi by default). On EKS, install and verify a compatible EBS CSI driver and StorageClass before deployment. External MongoDB does not make the complete stack fit a single small worker: default application/init requests total 2816Mi, plus existing system workloads, and eight steady pods require an additional slot for the bucket initialization Job. Measure capacity and preserve honest requests and limits before deployment; the example does not lower them. The optional executor adds another pod and 512Mi requested memory.

## Argo CD evaluation

`argocd-application.example.yaml` starts with local MongoDB and loopback URLs for explicit port-forward evaluation. Replace the commit placeholder with an immutable chart commit and every image placeholder with a verified matching-source digest (including the separately published fanout image). The example intentionally has no automated sync, pruning, or namespace creation. Create the destination namespace separately and sync manually only after the following gates pass:

1. All referenced images pull on the worker architecture and match the selected source revision.
2. The namespace contains `bike4mind-runtime` with every required runtime key, generated independently of Git and Helm values.
3. EBS CSI is healthy and `gp3-retain` exists with retain semantics and compatible scheduling; verify persistent-volume provisioning before synchronization.
4. Available CPU, memory, pod slots, and volume attachment capacity cover the complete workload plus the initializer Job and rollout overhead. Current resource requests and limits remain unchanged; this example does not establish that any particular worker fits.

Review the rendered manifests before each manual sync. Keep pruning disabled and preserve retained PVCs during rollback. Atlas can be configured later through the external Mongo mode and the existing runtime Secret; changing the mode does not migrate local data.
