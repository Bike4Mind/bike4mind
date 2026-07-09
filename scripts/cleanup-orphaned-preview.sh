#!/usr/bin/env bash
#
# cleanup-orphaned-preview.sh
#
# Manually clean up a preview stage whose `sst remove` failed with:
#   DependencyViolation: resource sg-... has a dependent object
# on ChatCompletionLoadBalancerSecurityGroup (legacy stacks: QuestProcessorServiceLoadBalancerSecurityGroup).
#
# Root cause (confirmed from the pr9702 cleanup log): `sst remove` tears down the
# target group and then the ALB's security group, but it never deletes the ALB
# itself. The live ALB's ENI still holds the SG, so the SG delete fails. Fix: delete
# the ALB first, wait for its ENIs to detach, THEN re-run `sst remove` to clear the
# SG, the default-SG ingress rule, and the rest of the stage.
#
# This is a stopgap until the Cloud Map structural fix (no per-preview ALB) lands.
#
# Usage:
#   ./scripts/cleanup-orphaned-preview.sh pr9702        # clean one stage
#   ./scripts/cleanup-orphaned-preview.sh --auto        # find + clean all CLOSED-PR orphans
#   DRY_RUN=1 ./scripts/cleanup-orphaned-preview.sh --auto
#   FORCE=1  ./scripts/cleanup-orphaned-preview.sh pr9702   # skip the open-PR safety check
#
# Env (defaults target the previews account):
#   AWS_PROFILE=bike4mind-previews  AWS_REGION=us-east-2  REPO=MillionOnMars/lumina5
#   DRAIN_SECONDS=180  DRY_RUN=0  FORCE=0
#
# Must be run from the lumina5 repo root (needs sst.config.ts for `sst remove`).
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-bike4mind-previews}"
AWS_REGION="${AWS_REGION:-us-east-2}"
REPO="${REPO:-MillionOnMars/lumina5}"
DRAIN_SECONDS="${DRAIN_SECONDS:-180}"
DRY_RUN="${DRY_RUN:-0}"
FORCE="${FORCE:-0}"
export AWS_PROFILE AWS_REGION

cd "$(git rev-parse --show-toplevel)"

run() {
  if [ "$DRY_RUN" = "1" ]; then echo "  DRY-RUN: $*"; else echo "  + $*"; "$@"; fi
}

# Print the QuestProcessor ALB ARN(s) tagged for a given stage (usually 0 or 1).
alb_arns_for_stage() {
  local stage="$1" arn s
  for arn in $(aws elbv2 describe-load-balancers --region "$AWS_REGION" \
      --query "LoadBalancers[?contains(LoadBalancerName,'ChatCompletion') || contains(LoadBalancerName,'QuestProcessor')].LoadBalancerArn" \
      --output text 2>/dev/null); do
    s=$(aws elbv2 describe-tags --region "$AWS_REGION" --resource-arns "$arn" \
        --query "TagDescriptions[0].Tags[?Key=='sst:stage']|[0].Value" --output text 2>/dev/null || true)
    [ "$s" = "$stage" ] && echo "$arn"
  done
  return 0   # never let a non-matching final iteration's test trip `set -e` in `arns=$(...)`
}

# Safety: refuse to nuke a preview whose PR is still OPEN (unless FORCE=1).
pr_is_open() {
  local stage="$1" num state
  num="${stage#pr}"
  [[ "$num" =~ ^[0-9]+$ ]] || return 1   # not a pr<N> stage → can't check → treat as not-open
  state=$(gh pr view "$num" --repo "$REPO" --json state -q .state 2>/dev/null || echo UNKNOWN)
  [ "$state" = "OPEN" ]
}

cleanup_stage() {
  local stage="$1"
  echo "=== stage: $stage ==="

  if [ "$FORCE" != "1" ] && pr_is_open "$stage"; then
    echo "  ⚠️  ${stage}'s PR is still OPEN — this is a live preview. Skipping (set FORCE=1 to override)."
    return 0
  fi

  local arns
  arns=$(alb_arns_for_stage "$stage")
  if [ -n "$arns" ]; then
    for arn in $arns; do
      echo "  Orphaned ALB: $arn"
      run aws elbv2 delete-load-balancer --region "$AWS_REGION" --load-balancer-arn "$arn"
    done
    echo "  Waiting ${DRAIN_SECONDS}s for ALB ENIs to detach before the SG can be deleted..."
    [ "$DRY_RUN" = "1" ] || sleep "$DRAIN_SECONDS"
  else
    echo "  No QuestProcessor ALB tagged for ${stage} (already gone) — going straight to sst remove."
  fi

  # Deleting the ALB cascade-deletes its Listener and removes the LB record, but SST state
  # still lists them — so a plain `sst remove` aborts with `ListenerNotFound` and strands
  # the rest of the stage. Drop those two from state (state-only edit, no AWS calls) so the
  # destroy skips them; the Target Group + SG survive the ALB delete and are removed by
  # `sst remove` normally. Targets are matched by exact resource NAME (the SG has a distinct
  # name and is intentionally left in state). `sst state remove` prompts to commit, so pipe
  # "Y"; an already-absent resource reports "No changes made" — a harmless no-op.
  # NOTE: do NOT use `sst refresh` here — it re-runs the program and re-adds state.
  # RouterServerCachePolicy is the SHARED CloudFront cache policy
  # (bike4mind-previews-shared-server) — all previews reference it to stay under the
  # per-account cache-policy limit. Previews deployed before the retainOnDelete pin have it
  # in state as deletable, so `sst remove` tries to delete it and AWS rejects with
  # CachePolicyInUse (it's in use by other previews). Dropping it from state retains the
  # shared policy in AWS. Harmless no-op for previews that already retain it.
  # ChatCompletion* = current SST logical id; QuestProcessorService* = legacy (pre-rename)
  # orphans. Both are listed so this works across the rename window; absent names no-op.
  for name in ChatCompletionListenerHTTP80 ChatCompletionLoadBalancer QuestProcessorServiceListenerHTTP80 QuestProcessorServiceLoadBalancer RouterServerCachePolicy; do
    if [ "$DRY_RUN" = "1" ]; then
      echo "  DRY-RUN: (echo Y | sst state remove --stage $stage $name)"
    else
      echo "  Dropping stale state entry: $name"
      echo "Y" | pnpm sst state remove --stage "$stage" "$name" 2>&1 \
        | grep -aiE "Removing|Resource removed|No changes" | sed 's/^/    /' || true
    fi
  done

  # sst remove now deletes the SG (ALB gone → ENI drained → no DependencyViolation), the
  # Target Group, cluster, and the rest. Idempotent + resumable.
  run pnpm sst remove --stage "$stage" --yes \
    || echo "  ::warning:: sst remove still non-zero for ${stage}; inspect for other dependent objects."

  # Best-effort: drop the GitHub Environment so it doesn't linger as a zombie env.
  run gh api --method DELETE "repos/${REPO}/environments/${stage}" || true
  echo "=== done: $stage ==="
}

# --auto: every QuestProcessor ALB SG whose stage tag maps to a CLOSED/MERGED PR.
auto_find_orphans() {
  aws ec2 describe-security-groups --region "$AWS_REGION" \
    --filters Name=group-name,Values='ChatCompletionLoadBalancer*','QuestProcessorServiceLoadBalancer*' \
    --query "SecurityGroups[].[Tags[?Key=='sst:stage']|[0].Value]" --output text 2>/dev/null \
  | tr '\t' '\n' | sed '/^$/d' | sort -u | while read -r stage; do
    num="${stage#pr}"
    [[ "$num" =~ ^[0-9]+$ ]] || continue
    state=$(gh pr view "$num" --repo "$REPO" --json state -q .state 2>/dev/null || echo UNKNOWN)
    case "$state" in CLOSED|MERGED) echo "$stage" ;; esac
  done
}

main() {
  case "${1:-}" in
    --auto)
      echo "Scanning ${AWS_PROFILE}/${AWS_REGION} for closed-PR preview orphans..."
      orphans=$(auto_find_orphans)
      if [ -z "$orphans" ]; then echo "No orphaned closed-PR preview stages found."; exit 0; fi
      echo "Orphaned stages: $(echo "$orphans" | tr '\n' ' ')"
      # Don't let one stage's transient failure (throttling, IAM edge, 5xx) strand the
      # rest of the sweep — report and continue to the next orphan.
      for s in $orphans; do
        cleanup_stage "$s" || echo "  ⚠️  cleanup_stage failed for $s — continuing to next orphan."
      done
      ;;
    pr[0-9]*)
      cleanup_stage "$1"
      ;;
    *)
      echo "Usage: $0 <stage|--auto>   e.g. $0 pr9702   |   $0 --auto"
      echo "Env: DRY_RUN=1 to preview, FORCE=1 to override the open-PR guard."
      exit 1
      ;;
  esac
}
main "$@"
