import { afterEach, describe, expect, it } from 'vitest';
import { currentBillingPayer, PERSONAL_PAYER, setBillingPayerSource } from './billingPayer';

describe('currentBillingPayer', () => {
  afterEach(() => setBillingPayerSource(() => PERSONAL_PAYER));

  it('waits for the remembered selection to load before answering', async () => {
    let organization: string | null = null;
    let finishLoading: () => void = () => undefined;
    const loaded = new Promise<void>(resolve => {
      finishLoading = resolve;
    });
    setBillingPayerSource(() => ({ organization_id: organization }), loaded);

    const payer = currentBillingPayer();
    organization = 'org-1';
    finishLoading();

    expect(await payer).toEqual({ organization_id: 'org-1' });
  });
});
