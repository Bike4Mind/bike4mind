FROM golang:1.23.10-bookworm@sha256:6dc1438aa1566f753bba3dbc5e3a1c4aa5de0a3b7b5f8c215d04d3d4ce1e811b AS build
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
RUN git clone --depth 1 --branch RELEASE.2025-08-13T08-35-41Z https://github.com/minio/mc.git /src
WORKDIR /src
RUN test "$(git rev-parse HEAD)" = "7394ce0dd2a80935aded936b09fa12cbb3cb8096"
RUN go build -trimpath -tags kqueue -ldflags "$(go run buildscripts/gen-ldflags.go 2025-08-13T08:35:41Z)" -o /out/mc .
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl jq && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/mc /usr/bin/mc
COPY --from=build /src/LICENSE /licenses/LICENSE
COPY --from=build /src/README.md /licenses/README.md
ENTRYPOINT ["mc"]
