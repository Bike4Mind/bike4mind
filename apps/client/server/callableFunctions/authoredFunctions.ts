import type {
  AuthoredFunction,
  AuthoredFunctionDetail,
  CallableFunctionCallSummary,
  CallableFunctionServerRun,
  ICallableFunctionDetail,
  ICallableFunctionGrants,
  ICallableFunctionPublic,
} from '@bike4mind/common';
import type { CallableFunctionPromotion } from '@bike4mind/server-utils/callableFunctions/promote';
import type {
  CallableFunctionShareInput,
  CallableFunctionShareView,
} from '@bike4mind/server-utils/callableFunctions/sharing';
import type { CallableFunctionTestRun } from '@bike4mind/server-utils/callableFunctions/testRun';

/*
 * The snake_case wire of the public authoring routes (functionsAuthoring.contract.ts), mapped from what the services
 * in packages/server-utils/src/callableFunctions return to the app's routes. Mapping only: no rule lives here.
 */

const iso = (date: Date | string) => new Date(date).toISOString();

const toShare = (grants: ICallableFunctionGrants) => ({
  visibility: grants.visibility,
  ...(grants.projectId ? { project_id: grants.projectId } : {}),
  ...(grants.organizationId ? { organization_id: grants.organizationId } : {}),
  user_ids: [...grants.userIds],
});

export function toAuthoredFunction(fn: ICallableFunctionPublic): AuthoredFunction {
  return {
    id: fn.id,
    slug: fn.slug,
    description: fn.description,
    state: fn.state,
    status: fn.status,
    enabled: fn.enabled,
    approval: fn.approval,
    trust_label: fn.trustLabel,
    pin_version: fn.pin.version,
    pin_seq: fn.pin.seq ?? null,
    code_hash: fn.pin.contentHash,
    pinned_at: iso(fn.pin.pinnedAt),
    artifact_id: fn.pin.artifactId,
    latest_version: fn.latestVersion,
    update_available: fn.updateAvailable,
    data: fn.dataPins.map(pin => ({
      name: pin.name,
      sha256: pin.sha256,
      bytes: pin.bytes,
      pinned_at: iso(pin.pinnedAt),
    })),
    sources: fn.sources.map(({ name, url, mode, pinned }) => ({
      name,
      url,
      mode,
      ...(pinned ? { pinned: { sha256: pinned.sha256, bytes: pinned.bytes, fetched_at: iso(pinned.fetchedAt) } } : {}),
    })),
    examples: fn.examples.map(({ name, input, expected, tolerance, citation }) => ({
      name,
      input,
      expected,
      ...(tolerance ? { tolerance } : {}),
      citation,
    })),
    share: fn.grants ? toShare(fn.grants) : null,
    created_at: iso(fn.createdAt),
    updated_at: iso(fn.updatedAt),
  };
}

function toServerRun(run: CallableFunctionServerRun) {
  return {
    at: iso(run.at),
    passed: run.passed,
    failed: run.failed,
    results: run.results.map(result => ({
      name: result.name,
      kind: result.kind,
      passed: result.passed,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      duration_ms: result.durationMs,
      call_id: result.callId,
    })),
    ...(run.stamp ? { stamp: run.stamp } : {}),
  };
}

export function toAuthoredFunctionDetail(fn: ICallableFunctionDetail): AuthoredFunctionDetail {
  return {
    ...toAuthoredFunction(fn),
    code: fn.source,
    contract: { ...fn.contract },
    last_server_run: fn.lastServerRun ? toServerRun(fn.lastServerRun) : null,
  };
}

export function toTestRun(run: CallableFunctionTestRun) {
  return {
    function_id: run.functionId,
    passed: run.passed,
    failed: run.failed,
    not_run: run.notRun,
    results: run.results.map(result => {
      if (result.outcome === 'not_run') {
        return {
          name: result.name,
          passed: false,
          outcome: result.outcome,
          reason: result.reason,
          mismatch: null,
          ...(result.callId ? { call_id: result.callId } : {}),
        };
      }
      return {
        name: result.name,
        passed: result.passed,
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.errorClass ? { error_class: result.errorClass } : {}),
        ...(result.problems ? { problems: result.problems } : {}),
        mismatch: result.mismatch,
        duration_ms: result.durationMs,
        call_id: result.callId,
        ...(result.stamp ? { stamp: result.stamp } : {}),
      };
    }),
  };
}

export const toPromotion = (promotion: CallableFunctionPromotion) => ({
  function: toAuthoredFunction(promotion.function),
  run: toServerRun(promotion.run),
});

export const toShareView = (view: CallableFunctionShareView) => ({
  share: view.grants ? toShare(view.grants) : null,
  people: view.people,
});

export const toShareInput = (body: {
  visibility: CallableFunctionShareInput['visibility'];
  project_id?: string;
  organization_id?: string;
  user_ids: string[];
}): CallableFunctionShareInput => ({
  visibility: body.visibility,
  ...(body.project_id ? { projectId: body.project_id } : {}),
  ...(body.organization_id ? { organizationId: body.organization_id } : {}),
  userIds: body.user_ids,
});

export const toCallSummary = (summary: CallableFunctionCallSummary) => ({
  since: iso(summary.since),
  total: summary.total,
  outcomes: summary.outcomes as Record<string, number>,
  recent: summary.recent.map(call => ({
    id: call.id,
    started_at: iso(call.startedAt),
    outcome: call.outcome,
    surface: call.surface,
    by_recipient: call.byRecipient,
    ...(call.pinSeq !== undefined ? { pin_seq: call.pinSeq } : {}),
    duration_ms: call.durationMs,
    ...(call.apiKey ? { api_key: call.apiKey } : {}),
  })),
});
