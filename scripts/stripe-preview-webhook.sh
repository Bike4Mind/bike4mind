#!/usr/bin/env bash
# Automate Stripe test-mode webhook wiring for a preview (PR) environment.
#
# Replaces the manual Stripe dashboard dance documented in the README's
# "Testing Stripe on Preview Servers" section. The Stripe CLI's
# `webhook_endpoints create` returns the signing secret directly on creation
# (the dashboard only shows it once, which is why the manual flow is so fiddly),
# so we can create the endpoint, capture the secret, and store it as an SST
# secret for the preview stage in a single command.
#
# Usage:
#   ./scripts/stripe-preview-webhook.sh setup    <pr-number>
#   ./scripts/stripe-preview-webhook.sh teardown <pr-number>
#
# Examples:
#   ./scripts/stripe-preview-webhook.sh setup 9639
#   ./scripts/stripe-preview-webhook.sh teardown 9639
#
# Prerequisites (checked at runtime):
#   - Stripe CLI, authenticated once with `stripe login` (operates in TEST mode
#     by default — do NOT run this against a live-mode key).
#   - jq
#   - AWS credentials for the `bike4mind-previews` profile (via ./for-env previews).

set -euo pipefail

# Events the webhook handler actually processes
# (apps/client/pages/api/stripe/webhook.ts). Keep this list in sync with the
# `case` labels in that handler — enabling extras just adds delivery noise.
ENABLED_EVENTS=(
  charge.dispute.closed
  charge.dispute.created
  charge.refunded
  checkout.session.completed
  checkout.session.expired
  customer.deleted
  customer.subscription.deleted
  customer.subscription.updated
  invoice.payment_failed
  invoice.payment_succeeded
  payment_intent.payment_failed
  payment_intent.succeeded
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

err()  { echo -e "${RED}✗ $*${NC}" >&2; }
ok()   { echo -e "${GREEN}✓ $*${NC}"; }
warn() { echo -e "${YELLOW}! $*${NC}"; }

usage() {
  cat <<'EOF'
USAGE: ./scripts/stripe-preview-webhook.sh <command> <pr-number>

COMMANDS:
  setup    <pr-number>   Create a test-mode webhook endpoint for the preview and
                         store its signing secret as the STRIPE_WEBHOOK_SECRET
                         SST secret for stage pr<pr-number>.
  teardown <pr-number>   Delete the test-mode webhook endpoint pointing at the
                         preview (stops Stripe from emailing delivery failures).

EXAMPLES:
  ./scripts/stripe-preview-webhook.sh setup 9639
  ./scripts/stripe-preview-webhook.sh teardown 9639
EOF
}

# Resolve the repo root so the script works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

require_tools() {
  local missing=0
  for tool in stripe jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      err "Required tool not found: $tool"
      missing=1
    fi
  done
  if [[ ! -x "$REPO_ROOT/for-env" ]]; then
    err "Cannot find executable ./for-env at repo root ($REPO_ROOT)"
    missing=1
  fi
  [[ "$missing" -eq 0 ]] || exit 1

  # `stripe config --list` fails if the CLI has never been authenticated.
  if ! stripe config --list >/dev/null 2>&1; then
    err "Stripe CLI is not authenticated. Run: stripe login"
    err "(This must target the Bike4Mind account in TEST mode.)"
    exit 1
  fi
}

# Validate + normalize the PR number, then derive URL + stage.
webhook_url_for() { echo "https://app.pr$1.preview.bike4mind.com/api/stripe/webhook"; }
stage_for()       { echo "pr$1"; }

parse_pr() {
  local raw="${1:-}"
  # Accept "9639" or "pr9639".
  raw="${raw#pr}"
  if [[ ! "$raw" =~ ^[0-9]+$ ]]; then
    err "Invalid PR number: '${1:-}'. Expected a number like 9639 or pr9639."
    exit 1
  fi
  echo "$raw"
}

# Find an existing endpoint id for the given URL, or empty string.
find_endpoint_id() {
  local url="$1"
  stripe webhook_endpoints list --limit 100 \
    | jq -r --arg url "$url" '.data[] | select(.url == $url) | .id' \
    | head -n1
}

cmd_setup() {
  local pr; pr="$(parse_pr "${1:-}")"
  local url stage; url="$(webhook_url_for "$pr")"; stage="$(stage_for "$pr")"

  echo "Setting up Stripe test-mode webhook for preview pr$pr"
  echo "  URL:   $url"
  echo "  Stage: $stage"
  echo

  # Idempotency: reuse an existing endpoint rather than creating a duplicate.
  # NOTE: Stripe only returns the signing secret on CREATE, so if an endpoint
  # already exists we cannot recover its secret — the user must tear it down
  # first (or copy the secret from the dashboard).
  local existing; existing="$(find_endpoint_id "$url")"
  if [[ -n "$existing" ]]; then
    err "A webhook endpoint for this URL already exists ($existing)."
    err "Its signing secret can't be re-read via the API. Tear it down first:"
    err "  ./scripts/stripe-preview-webhook.sh teardown $pr"
    exit 1
  fi

  # The Stripe CLI expects array params as repeated `-d "enabled_events[]=..."`
  # entries. Passing a single comma-joined string lands the whole list in
  # enabled_events[0] and Stripe rejects it as an invalid event name.
  local -a data_args=(
    -d "url=$url"
    -d "description=Preview pr$pr (created by stripe-preview-webhook.sh)"
  )
  local ev
  for ev in "${ENABLED_EVENTS[@]}"; do
    data_args+=( -d "enabled_events[]=$ev" )
  done

  echo "Creating webhook endpoint (${#ENABLED_EVENTS[@]} events)..."
  local response
  response="$(stripe webhook_endpoints create "${data_args[@]}")"

  local endpoint_id secret
  endpoint_id="$(echo "$response" | jq -r '.id')"
  secret="$(echo "$response" | jq -r '.secret')"

  if [[ -z "$secret" || "$secret" == "null" ]]; then
    err "Stripe did not return a signing secret. Raw response:"
    echo "$response" >&2
    exit 1
  fi
  ok "Created endpoint $endpoint_id"

  echo "Storing STRIPE_WEBHOOK_SECRET for stage $stage..."
  ( cd "$REPO_ROOT" && ./for-env previews npx sst secret set STRIPE_WEBHOOK_SECRET "$secret" --stage "$stage" )
  ok "Secret stored for $stage"

  echo
  warn "Redeploy the preview environment so it picks up the new secret."
  warn "The preview redeploys on push to the PR branch — e.g. push a commit, or"
  warn "re-run the preview deploy for pr$pr."
  echo
  ok "Done. When finished testing, tear it down:"
  echo "  ./scripts/stripe-preview-webhook.sh teardown $pr"
}

cmd_teardown() {
  local pr; pr="$(parse_pr "${1:-}")"
  local url; url="$(webhook_url_for "$pr")"

  echo "Tearing down Stripe webhook for preview pr$pr"
  echo "  URL: $url"

  local endpoint_id; endpoint_id="$(find_endpoint_id "$url")"
  if [[ -z "$endpoint_id" ]]; then
    warn "No webhook endpoint found for this URL. Nothing to delete."
    exit 0
  fi

  echo "Deleting endpoint $endpoint_id..."
  # --confirm skips the CLI's interactive warning prompt (it otherwise stalls in
  # a non-TTY and the delete never happens). Verify the API actually reported
  # the endpoint as deleted rather than trusting a swallowed exit code.
  local response; response="$(stripe webhook_endpoints delete "$endpoint_id" --confirm 2>&1)"
  if [[ "$(echo "$response" | jq -r '.deleted' 2>/dev/null)" != "true" ]]; then
    err "Delete did not confirm. Stripe response:"
    echo "$response" >&2
    exit 1
  fi
  ok "Deleted $endpoint_id"
  warn "The STRIPE_WEBHOOK_SECRET SST secret for pr$pr is left as-is (harmless;"
  warn "the preview is typically torn down with the PR anyway)."
}

main() {
  local command="${1:-}"
  case "$command" in
    setup)    require_tools; shift; cmd_setup "$@" ;;
    teardown) require_tools; shift; cmd_teardown "$@" ;;
    -h|--help|help|"") usage ;;
    *) err "Unknown command: $command"; echo; usage; exit 1 ;;
  esac
}

main "$@"
