// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

// Pin each route's target guard, including shared approval and Stripe executors.
const cases = [
  {
    path: 'pages/api/admin/users/[userId]/grant-subscription.ts',
    guard: 'assertDelegateCanCreditUser',
  },
  {
    path: 'pages/api/admin/users/[userId]/subscriptions/[subscriptionId]/credits.ts',
    guard: 'assertDelegateCanChangeSubscription',
  },
  {
    path: 'pages/api/admin/users/[userId]/subscriptions/[subscriptionId]/remove.ts',
    guard: 'assertDelegateCanChangeSubscription',
  },
  {
    path: 'pages/api/admin/users/[userId]/new-account-spend-cap.ts',
    guard: 'assertCanActOnAdminTarget',
  },
  {
    path: 'pages/api/admin/users/[userId]/unlock-signup-grant.ts',
    guard: 'readSignupGrantAdminAction',
  },
  {
    path: 'pages/api/admin/users/[userId]/release-held-signup-grant.ts',
    guard: 'readSignupGrantAdminAction',
  },
  {
    path: 'pages/api/admin/held-signup-grants/release.ts',
    guard: 'assertDelegateCanCreditUsers',
  },
  {
    path: 'pages/api/admin/held-signup-grants/revoke.ts',
    guard: 'assertDelegateCanCreditUsers',
  },
  {
    path: 'pages/api/admin/subscriptions/[id]/comp.ts',
    guard: 'assertDelegateCanChangeSubscription',
  },
  {
    path: 'pages/api/admin/subscriptions/[id]/sync.ts',
    guard: 'assertDelegateCanChangeSubscription',
  },
  {
    path: 'pages/api/admin/subscriptions/[id]/cancel.ts',
    guard: 'runAdminStripeWrite',
  },
  {
    path: 'pages/api/admin/subscriptions/[id]/resume.ts',
    guard: 'runAdminStripeWrite',
  },
  {
    path: 'pages/api/admin/organizations/grant.ts',
    guard: 'assertDelegateCanCreditUser',
  },
  {
    path: 'pages/api/admin/organizations/[id]/top-up.ts',
    guard: 'assertDelegateCanCreditOrganization',
  },
  {
    path: 'pages/api/admin/organizations/[id]/seats.ts',
    guard: 'assertDelegateCanCreditOrganization',
  },
  {
    path: 'pages/api/admin/organizations/[id]/convert-to-paid.ts',
    guard: 'assertDelegateCanCreditOrganization',
  },
  {
    path: 'pages/api/admin/organizations/[id]/revoke.ts',
    guard: 'assertDelegateCanCreditOrganization',
  },
  {
    path: 'server/admin/creditGrants/grantOrg.ts',
    guard: 'assertDelegateCanCreditUser',
  },
  {
    path: 'server/admin/creditGrants/grantSubscription.ts',
    guard: 'assertDelegateCanCreditUser',
  },
  {
    path: 'server/admin/creditGrants/topUpOrg.ts',
    guard: 'assertDelegateCanCreditOrganization',
  },
  {
    path: 'server/admin/stripeWrite/adminStripeWrite.ts',
    guard: 'assertDelegateCanChangeSubscription',
  },
] as const;

describe('credit delegate target guard wiring', () => {
  it.each(cases)('$path calls $guard', ({ path, guard }) => {
    const filename = fileURLToPath(new URL(`../../../${path}`, import.meta.url));
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === guard) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls.length, `${path} must call its target guard`).toBeGreaterThan(0);
    if (guard !== 'readSignupGrantAdminAction') return;
    expect(
      calls.some(call => {
        const options = call.arguments[2];
        return (
          options &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            property =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === 'guardTargetVerb' &&
              ts.isStringLiteral(property.initializer) &&
              property.initializer.text.length > 0
          )
        );
      }),
      `${path} must enable the admin-target guard`
    ).toBe(true);
  });
});
