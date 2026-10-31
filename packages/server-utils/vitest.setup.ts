// Stripe price ids are account-tied and come from NEXT_PUBLIC_* env vars with no fallback. Seed
// real-format dummy ids so lib/entitlements/registry.ts resolves its staged price rows and
// registry.test.ts's "both stages real" guard still checks the wiring. Not real Stripe prices.
// Mirrors the seeds in apps/client/vitest.setup.ts.
process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST ??= 'price_test_org_sub';
process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_PROD ??= 'price_prod_org_sub';
process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST ??= 'price_test_professional';
process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD ??= 'price_prod_professional';
process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_TEST ??= 'price_test_libonc_pro';
process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_PROD ??= 'price_prod_libonc_pro';
