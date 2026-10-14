import { describe, it, expect } from 'vitest';
import { compareManifests } from './manifestComparator';
import { getControlledManifestFields } from './manifestTemplate';

const BASE_URL = 'https://app.test.com';

// A deep copy of the controlled fields is what an up-to-date live export looks like.
const upToDateLiveManifest = (enableWorkflowSteps = true): Record<string, any> =>
  JSON.parse(JSON.stringify(getControlledManifestFields(BASE_URL, { enableWorkflowSteps })));

const functionDifferences = (differences: Array<{ field: string }>) =>
  differences.filter(difference => difference.field.startsWith('functions.'));

describe('compareManifests - workflow step functions', () => {
  it('reports an untouched manifest as up to date', () => {
    const result = compareManifests(upToDateLiveManifest(), BASE_URL, { enableWorkflowSteps: true });

    expect(result.differences).toEqual([]);
    expect(result.isUpToDate).toBe(true);
  });

  it('flags a function whose user_context input was replaced by a user_id input', () => {
    const live = upToDateLiveManifest();
    const params = live.functions.b4m_send_message.input_parameters;
    delete params.user_context;
    params.user_id = { type: 'slack#/types/user_id' };

    const result = compareManifests(live, BASE_URL, { enableWorkflowSteps: true });

    expect(result.isUpToDate).toBe(false);
    expect(result.differences).toHaveLength(1);
    const [difference] = result.differences;
    expect(difference.field).toBe('functions.b4m_send_message.input_parameters');
    expect(difference.actual).toMatchObject({ user_id: 'slack#/types/user_id' });
    expect(difference.actual).not.toHaveProperty('user_context');
    expect(difference.expected).toMatchObject({ user_context: 'slack#/types/user_context' });
  });

  it('flags an input whose type changed under the same name', () => {
    const live = upToDateLiveManifest();
    live.functions.b4m_query.input_parameters.user_context.type = 'slack#/types/user_id';

    const result = compareManifests(live, BASE_URL, { enableWorkflowSteps: true });

    expect(functionDifferences(result.differences).map(d => d.field)).toEqual(['functions.b4m_query.input_parameters']);
  });

  it('ignores title and description changes', () => {
    const live = upToDateLiveManifest();
    for (const func of Object.values<any>(live.functions)) {
      func.title = 'Renamed step';
      func.description = 'Rebranded description';
    }

    const result = compareManifests(live, BASE_URL, { enableWorkflowSteps: true });

    expect(functionDifferences(result.differences)).toEqual([]);
    expect(result.isUpToDate).toBe(true);
  });

  it('reports a missing function as functions.<name>', () => {
    const live = upToDateLiveManifest();
    delete live.functions.b4m_create_notebook;

    const result = compareManifests(live, BASE_URL, { enableWorkflowSteps: true });

    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]).toMatchObject({ field: 'functions.b4m_create_notebook', actual: undefined });
  });

  it('does not compare functions when workflow steps are disabled', () => {
    const live = upToDateLiveManifest(false);
    live.functions = {
      b4m_send_message: { input_parameters: { user_id: { type: 'slack#/types/user_id' } } },
    };

    const result = compareManifests(live, BASE_URL, { enableWorkflowSteps: false });

    expect(functionDifferences(result.differences)).toEqual([]);
    expect(result.isUpToDate).toBe(true);
  });
});
