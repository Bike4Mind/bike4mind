#!/usr/bin/env bash
#
# reconcile-orphaned-alb.sh <stage>
#
# Self-heal for a DESYNCED preview teardown. An interrupted or partial prior
# `sst remove` (CI job-timeout kill, runner death) can leave the ChatCompletion
# ALB live in AWS but dropped from SST state. A retry then deletes the ALB's
# security group while the live ALB - and the ingress rule on the shared VPC
# `default` SG that references it as source - still pin it, so `sst remove`
# fails with `DependencyViolation`. This clears those blockers directly so the
# caller can retry `sst remove` cleanly.
#
# STRICTLY stage-scoped. It only acts on:
#   - security groups tagged sst:stage=<stage> (SST-created; the shared `default`
#     SG is NOT tagged per-stage, so it is never selected for deletion), and
#   - ingress rules on the VPC `default` SG that REFERENCE those stage SGs.
# It never touches prod or another stage. Every step is best-effort and idempotent.
#
# Requires AWS creds in the environment. AWS_REGION defaults to us-east-2.
set -uo pipefail

STAGE="${1:?usage: reconcile-orphaned-alb.sh <stage>}"
REGION="${AWS_REGION:-us-east-2}"
DRAIN_TRIES="${DRAIN_TRIES:-20}"   # x15s = up to 5 minutes
log() { echo "[reconcile ${STAGE}] $*"; }

# 1. SST-created security groups for this stage (the ALB SG). Tag-scoped, so the
#    shared `default` SG (untagged per-stage) can never appear here.
STAGE_SGS=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=tag:sst:stage,Values=${STAGE}" \
  --query 'SecurityGroups[].GroupId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)

if [ -z "$STAGE_SGS" ]; then
  log "no SST-tagged security groups for this stage; nothing to reconcile"
fi

# 2. Revoke dangling ingress rules on each stage SG's VPC `default` SG that
#    reference the stage SG as source (the AlbToTask rule). A SG referenced as a
#    rule source cannot be deleted until that rule is revoked.
for sg in $STAGE_SGS; do
  vpc=$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$sg" \
        --query 'SecurityGroups[0].VpcId' --output text 2>/dev/null || true)
  if [ -z "$vpc" ] || [ "$vpc" = "None" ]; then continue; fi
  default_sg=$(aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=vpc-id,Values=${vpc}" "Name=group-name,Values=default" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
  if [ -z "$default_sg" ] || [ "$default_sg" = "None" ]; then continue; fi
  rules=$(aws ec2 describe-security-group-rules --region "$REGION" \
    --filters "Name=group-id,Values=${default_sg}" \
    --query "SecurityGroupRules[?ReferencedGroupInfo.GroupId=='${sg}'].SecurityGroupRuleId" \
    --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
  for rid in $rules; do
    if aws ec2 revoke-security-group-ingress --region "$REGION" \
         --group-id "$default_sg" --security-group-rule-ids "$rid" >/dev/null 2>&1; then
      log "revoked dangling rule ${rid} on default SG ${default_sg} (referenced ${sg})"
    else
      log "could not revoke ${rid} (may already be gone)"
    fi
  done
done

# 3. Delete this stage's load balancer(s). An untracked ALB is invisible to
#    `sst remove`, so delete it directly; its ENIs then drain and release the SG.
albs=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --query 'LoadBalancers[].LoadBalancerArn' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
for arn in $albs; do
  st=$(aws elbv2 describe-tags --region "$REGION" --resource-arns "$arn" \
       --query "TagDescriptions[0].Tags[?Key=='sst:stage'].Value|[0]" --output text 2>/dev/null || true)
  if [ "$st" = "$STAGE" ]; then
    if aws elbv2 delete-load-balancer --region "$REGION" --load-balancer-arn "$arn" >/dev/null 2>&1; then
      log "deleted orphaned ALB ${arn##*loadbalancer/}"
    else
      log "could not delete ALB ${arn##*loadbalancer/}"
    fi
  fi
done

# 4. Wait for ENIs to drain off each stage SG (the ALB's ENIs hold it until the
#    ALB is fully gone), then delete the SG. If the SG is still tracked in state,
#    the caller's retry `sst remove` no-ops on the already-deleted id.
for sg in $STAGE_SGS; do
  log "waiting for ENIs to drain off ${sg} (up to $((DRAIN_TRIES*15))s)..."
  i=0
  while [ "$i" -lt "$DRAIN_TRIES" ]; do
    n=$(aws ec2 describe-network-interfaces --region "$REGION" \
        --filters "Name=group-id,Values=${sg}" \
        --query 'length(NetworkInterfaces)' --output text 2>/dev/null || echo 1)
    [ "$n" = "0" ] && break
    i=$((i+1)); sleep 15
  done
  if aws ec2 delete-security-group --region "$REGION" --group-id "$sg" >/dev/null 2>&1; then
    log "deleted stage SG ${sg}"
  else
    log "did not delete SG ${sg} (already gone, or still pinned - retry sst remove will surface it)"
  fi
done

log "reconcile complete"
