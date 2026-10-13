#!/bin/sh
set -eu
for i in $(seq 1 180); do
  mc alias set local "$LOCAL_OBJECTSTORE_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 && break
  sleep 2
done
for bucket in "$APP_FILES_BUCKET" "$EMAIL_INGESTION_BUCKET" "$FAB_FILE_BUCKET" "$GENERATED_IMAGES_BUCKET" "$HISTORY_IMPORT_BUCKET" "$PUBLISHED_ARTIFACTS_BUCKET" "$SLACK_EXPORT_BUCKET"; do
  [ -n "$bucket" ]
  mc mb --ignore-existing "local/$bucket"
done
for bucket in "$FAB_FILE_BUCKET" "$HISTORY_IMPORT_BUCKET"; do
  mc event add "local/$bucket" arn:minio:sqs::primary:webhook --event put --ignore-existing
done
reconcile_expiry() {
  bucket=$1
  prefix=$2
  days=$3
  if listing=$(mc --json ilm rule ls "local/$bucket"); then
    rules=$(printf '%s' "$listing" | jq -ce '
      if .status == "success" and (.config.Rules | type) == "array"
      then .config.Rules else error("Invalid lifecycle listing") end')
  else
    printf '%s' "$listing" | jq -e '
      .status == "error" and .error.cause.error.Code == "NoSuchLifecycleConfiguration"' >/dev/null || {
      echo 'Unable to read lifecycle configuration' >&2
      return 1
    }
    rules='[]'
  fi
  selection=$(printf '%s' "$rules" | jq -ce --arg prefix "$prefix" --argjson days "$days" '
    def inactive:
      all(.. | scalars; . == null or . == false or . == 0 or . == "" or . == "0001-01-01T00:00:00Z");
    def exact_scope:
      (.Filter // {}) as $filter |
      ($filter.And // {}) as $andFilter |
      (($filter.Prefix // $andFilter.Prefix // .Prefix // "") == $prefix) and
      ($filter | del(.Prefix, .And) | length == 0) and
      ($andFilter | del(.Prefix) | length == 0);
    [.[] | select(exact_scope) | select((.Expiration.Days | type) == "number" and .Expiration.Days > 0) |
     select(.Expiration | del(.Days) | inactive)] as $candidates |
    {satisfied: any($candidates[]; .Status == "Enabled" and .Expiration.Days == $days),
     id: ($candidates[0].ID // "")}')
  if printf '%s' "$selection" | jq -e '.satisfied' >/dev/null; then
    return 0
  fi
  identity=$(printf '%s' "$selection" | jq -r '.id')
  if [ -n "$identity" ]; then
    mc ilm rule edit --id "$identity" --enable --expire-days "$days" "local/$bucket"
  else
    mc ilm rule add --expire-days "$days" --prefix "$prefix" "local/$bucket"
  fi
}
reconcile_expiry "$PUBLISHED_ARTIFACTS_BUCKET" drafts/ 7
reconcile_expiry "$HISTORY_IMPORT_BUCKET" '' 7
reconcile_expiry "$FAB_FILE_BUCKET" exports/ 1
reconcile_expiry "$FAB_FILE_BUCKET" generated-audio-offload/ 1
printf 'initialized\n' | mc pipe "local/$APP_FILES_BUCKET/.initialized-$INITIALIZATION_REVISION"
