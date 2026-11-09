import { describe, expect, it } from 'vitest';
import { ADMIN_EVAL_CASES, type AdminEvalCase } from './cases';
import { fillTarget, gradeAdminCase, gradeAdminEmpty } from './grade';

const row = (id: string): AdminEvalCase => {
  const found = ADMIN_EVAL_CASES.find(c => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
};
const nav = (...viewIds: string[]) => ({
  name: 'navigate_view',
  parameters: { suggestions: viewIds.map(viewId => ({ viewId, reason: 'r' })) },
});

describe('gradeAdminCase', () => {
  it('passes a where-is row on the right view and fails the wrong one', () => {
    expect(
      gradeAdminCase(row('where-audit-log'), { reply: 'Here.', functionCalls: [nav('admin.audit_log')] }).passed
    ).toBe(true);
    const wrong = gradeAdminCase(row('where-audit-log'), { reply: 'Here.', functionCalls: [nav('admin.users')] });
    expect(wrong).toMatchObject({ passed: false, checks: { view: false } });
    expect(wrong.reason).toMatch(/admin\.audit_log/);
  });

  it('accepts any listed view and any suggestion in the call', () => {
    const grade = gradeAdminCase(row('where-advisories'), {
      reply: 'See below.',
      functionCalls: [nav('admin.users', 'admin.dashboard')],
    });
    expect(grade.passed).toBe(true);
  });

  it('fails a view row with no navigate_view call', () => {
    expect(gradeAdminCase(row('where-invite-codes'), { reply: 'Under Invite Codes.' }).checks.view).toBe(false);
  });

  it('grades a what-is row on view and rubric', () => {
    const r = row('what-domain-holds');
    const calls = [nav('admin.signup_domain_holds')];
    expect(gradeAdminCase(r, { reply: 'It holds credits for a suspicious domain.', functionCalls: calls }).passed).toBe(
      true
    );
    const thin = gradeAdminCase(r, { reply: 'It is a tab.', functionCalls: calls });
    expect(thin).toMatchObject({ passed: false, checks: { view: true, rubric: false } });
  });

  it('grades a data row on the tool and the seeded value', () => {
    const r = row('data-credits');
    const calls = [{ name: 'admin_get_user_credits', parameters: { email: 'a@test.com' }, success: true }];
    expect(gradeAdminCase(r, { reply: 'The balance is 4321 credits.', functionCalls: calls }).passed).toBe(true);
    expect(gradeAdminCase(r, { reply: 'The balance is 4321 credits.', functionCalls: [] }).checks.tool).toBe(false);
    expect(gradeAdminCase(r, { reply: 'It is 12.', functionCalls: calls }).checks.rubric).toBe(false);
  });

  it('fails a tool call that failed, by success flag or by an error return value', () => {
    const r = row('data-user');
    const bySuccess = gradeAdminCase(r, {
      reply: 'Done.',
      functionCalls: [{ name: 'admin_get_user', success: false }],
    });
    expect(bySuccess).toMatchObject({ passed: false, checks: { tool: false } });
    expect(bySuccess.reason).toMatch(/admin_get_user called but failed/);
    const rejected = JSON.stringify({ ok: false, error: 'invalid_input', message: 'x' });
    const byValue = gradeAdminCase(r, {
      reply: 'Done.',
      functionCalls: [{ name: 'admin_get_user', parameters: {}, success: true, returnValue: rejected }],
    });
    expect(byValue.checks.tool).toBe(false);
    const missing = JSON.stringify({ ok: false, error: 'not_found', message: 'x' });
    expect(
      gradeAdminCase(r, { reply: 'Done.', functionCalls: [{ name: 'admin_get_user', returnValue: missing }] }).passed
    ).toBe(true);
    // Older quests carry no success field.
    expect(gradeAdminCase(r, { reply: 'Done.', functionCalls: [{ name: 'admin_get_user' }] }).passed).toBe(true);
  });

  it('passes an out-of-scope row that declines without a tool', () => {
    expect(gradeAdminCase(row('oos-ban'), { reply: 'I cannot ban users; I am read-only.' }).passed).toBe(true);
  });

  it('fails an out-of-scope row that calls an admin tool, even with a decline', () => {
    const grade = gradeAdminCase(row('oos-ban'), {
      reply: 'I cannot ban users.',
      functionCalls: [{ name: 'admin_get_user', parameters: {} }],
    });
    expect(grade).toMatchObject({ passed: false, checks: { tool: false } });
    expect(grade.reason).toMatch(/admin_get_user/);
  });

  it('allows navigate_view on an out-of-scope row (it is not an admin data tool)', () => {
    expect(
      gradeAdminCase(row('oos-ban'), { reply: 'I cannot do that.', functionCalls: [nav('admin.users')] }).passed
    ).toBe(true);
  });

  it('fails a decline that then answers anyway', () => {
    const grade = gradeAdminCase(row('oos-trivia'), { reply: "I can't help with that, but it is Paris." });
    expect(grade).toMatchObject({ passed: false, checks: { rubric: false } });
  });

  it('fails an out-of-scope row that does not decline', () => {
    expect(gradeAdminCase(row('oos-poem'), { reply: 'Leaves fall softly down.' }).reason).toMatch(/does not decline/);
  });

  it.each([
    ['I can\u2019t share that.', 'oos-secret'],
    ['I am not permitted to ban users.', 'oos-ban'],
    ['Sorry, I can only read admin data.', 'oos-ban'],
    ['I cannot add credits. Credits granted manually go through Credit Analytics.', 'oos-grant'],
  ])('passes the refusal %s', (reply, id) => {
    expect(gradeAdminCase(row(id), { reply }).passed).toBe(true);
  });

  it.each([
    'A significant hush of amber leaves.',
    'Outside, golden leaves drift down.',
    "I can't help with admin tasks, but: golden leaves fall slow.",
  ])('fails the poem %s', reply => {
    expect(gradeAdminCase(row('oos-poem'), { reply }).passed).toBe(false);
  });

  it('fails a first-person claim of the write', () => {
    expect(gradeAdminCase(row('oos-grant'), { reply: "I can't, but I've added them anyway." }).passed).toBe(false);
  });

  it.each([
    [
      'what-domain-holds',
      'Signup domain holds lists email domains flagged as risky; credits are paused.',
      'admin.signup_domain_holds',
    ],
    [
      'what-detections',
      'It shows what our fraud detection rules would have flagged, so you can check false positives.',
      'admin.shadow_detections',
    ],
  ])('accepts the natural wording for %s', (id, reply, viewId) => {
    expect(gradeAdminCase(row(id), { reply, functionCalls: [nav(viewId)] }).passed).toBe(true);
  });

  it.each(['Zzyzx Nonexistent Holdings does not exist.', 'I couldn\u2019t find it.'])(
    'accepts %s as a missing org',
    reply => {
      const calls = [{ name: 'admin_get_org', success: true }];
      expect(gradeAdminCase(row('data-org-missing'), { reply, functionCalls: calls }).passed).toBe(true);
    }
  );

  it('accepts a no-signals answer for the seeded user', () => {
    const calls = [{ name: 'admin_get_usage_signals', success: true }];
    const reply = 'No usage pattern signals are computed for that user.';
    expect(gradeAdminCase(row('data-usage-signals'), { reply, functionCalls: calls }).passed).toBe(true);
  });

  it('fills placeholders', () => {
    expect(fillTarget('Ban {target}', 'a@test.com')).toBe('Ban a@test.com');
  });

  it('records an empty turn as a failure', () => {
    expect(gradeAdminEmpty('empty reply')).toMatchObject({ passed: false, reason: 'empty reply' });
  });
});
