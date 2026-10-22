# SearXNG image for the internal web-search service (infra/searxng.ts).
#
# Built & pushed to ECR by the deploy pipeline (image contract in infra/deploy-contract.json);
# the build context is the monorepo root. Bakes in the same settings.yml the self-host compose
# stack mounts, so both deployments share one config. The secret is NOT in the image: it comes
# from the SEARXNG_SECRET env var set by infra. Pinned by digest so an upstream push to the tag
# cannot change the image silently; bump tag + digest together.
FROM docker.io/searxng/searxng:2026.9.29-4e2c1ea7f@sha256:3284e8900e9b3e5df284ae8c48a26851ae2eff6f99b4b0b18ec3da5a4d9095c3

COPY selfhost/searxng/settings.yml /etc/searxng/settings.yml
