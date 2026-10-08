# Self-host object storage

Compose builds MinIO and its `mc` client directly from unmodified upstream source. No prebuilt MinIO registry image or private registry access is needed.

| Component | Upstream release             | Verified source commit                   | Go toolchain |
| --------- | ---------------------------- | ---------------------------------------- | ------------ |
| MinIO     | RELEASE.2025-10-15T17-29-55Z | 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a | 1.24.8       |
| mc        | RELEASE.2025-08-13T08-35-41Z | 7394ce0dd2a80935aded936b09fa12cbb3cb8096 | 1.23.10      |

The Dockerfiles verify the fetched release's exact commit before compiling, use upstream metadata generation, and preserve the upstream MinIO entrypoint. The table names the source release inputs. Upstream metadata generation labels these source-built binaries `DEVELOPMENT` with the pinned timestamp and commit; they are not relabeled as vendor `RELEASE` binaries. Official Go and Debian base images are pinned to multi-platform digests supporting amd64 and arm64. Debian package installation and Go module downloads still require public network access. Package repositories are not snapshotted, so builds are not guaranteed to be byte-identical.

Both projects are licensed under AGPL-3.0. Each runtime image includes its upstream `LICENSE` and `README.md` in `/licenses`. Corresponding source and upstream documentation are available at:

- [MinIO source and build instructions](https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a).
- [mc source and build instructions](https://github.com/minio/mc/tree/7394ce0dd2a80935aded936b09fa12cbb3cb8096).

The path-scoped `selfhost-objectstore` workflow builds both images without a restored layer cache on native amd64 and arm64 runners. It checks the exact build timestamp, source commit, Go toolchain, shell and curl availability, runs the actual Compose bucket initializer twice, verifies all expected buckets and lifecycle rules, uploads and downloads objects, and checks authenticated object-created notifications for both configured buckets. Its lightweight webhook receiver replaces the app for this storage test; it does not validate application or model behavior.

To run the same test on a Docker-enabled Linux host:

```bash
docker compose -f compose.selfhost.yaml --env-file .env.selfhost build minio createbuckets
python3 scripts/smoke_selfhost_objectstore.py
```

Use a disposable checkout with a configured `.env.selfhost`. The smoke test creates a separate Compose project and deletes only that project's containers and data volume when it finishes.
