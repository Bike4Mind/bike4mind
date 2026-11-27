import { join } from 'node:path';
import { app, ipcMain, shell } from 'electron';
import type { AccountSelection } from '@shared/account';
import type { AuthState } from '@shared/auth';
import { IPC_CHANNELS } from '@shared/ipc';
import { onAuthStateChanged, type AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { PreferenceFile } from '../preferenceFile';
import { appWindows } from '../windows';
import { AccountService } from './AccountService';
import {
  ACCOUNT_SELECTION_FILE_NAME,
  AccountSelectionService,
  parseStoredAccountSelections,
} from './AccountSelectionService';
import { setBillingPayerSource } from './billingPayer';
import { BillingService } from './BillingService';
import { openCreditPayment } from './CreditPaymentWindow';

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

/**
 * Build the account service and expose its one read over IPC.
 *
 * Lives in main for the same reason every other server call does: the balance is an
 * authenticated read, and the access token never crosses the bridge.
 */
export function registerAccount(auth: AuthService): AccountService {
  const service = new AccountService({
    logger: createMainLogger(VERBOSE),
    getApiClient: () => auth.getApiClient(),
  });

  registerAccountSelection(auth, service);
  ipcMain.handle(IPC_CHANNELS.accountGetCredits, () => service.credits());
  ipcMain.handle(IPC_CHANNELS.accountGetProfile, () => service.profile());
  const billing = new BillingService({
    logger: createMainLogger(VERBOSE),
    getContext: () => {
      const api = auth.getApiClient();
      const state = auth.getState();
      return api && state.user ? { api, environmentUrl: state.environment.url, userId: state.user.id } : null;
    },
    openExternal: url => shell.openExternal(url),
    openCreditPayment,
  });
  ipcMain.handle(IPC_CHANNELS.accountGetBilling, () => billing.billing());
  ipcMain.handle(IPC_CHANNELS.accountSubscribePlan, (_event, priceId: unknown) => billing.subscribePlan(priceId));
  ipcMain.handle(IPC_CHANNELS.accountPurchaseCredits, (_event, packageId: unknown, acceptedTerms: unknown) =>
    billing.purchaseCredits(packageId, acceptedTerms)
  );
  ipcMain.handle(IPC_CHANNELS.accountSendFeedback, (_event, content: unknown) =>
    service.sendFeedback(content, auth.getState().user)
  );

  return service;
}

/** Who pays for credit-spending calls; every MediaApiClient and completion reads it per submit. */
function registerAccountSelection(auth: AuthService, account: AccountService): AccountSelectionService {
  const store = new PreferenceFile(
    join(app.getPath('userData'), ACCOUNT_SELECTION_FILE_NAME),
    parseStoredAccountSelections,
    'ACCOUNT'
  );
  const loaded = store.load();
  const selection = new AccountSelectionService({
    getApiClient: () => auth.getApiClient(),
    getUserId: () => auth.getState().user?.id ?? null,
    profile: () => account.profile(),
    store,
    ready: loaded,
    logger: createMainLogger(VERBOSE),
    onChanged: (next: AccountSelection) => {
      for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.accountSelectionChanged, next);
    },
  });
  setBillingPayerSource(() => selection.payer(), loaded);

  // A sign-in re-checks a remembered organization the user may have left before their first submit.
  const announce = (state: AuthState) => {
    if (state.status === 'signed-in') void selection.authChanged(state.user?.id ?? null);
    else if (state.status === 'signed-out' || state.status === 'unconfigured') void selection.authChanged(null);
  };
  announce(auth.getState());
  onAuthStateChanged(announce);

  ipcMain.handle(IPC_CHANNELS.accountGetSelection, (_event, fresh: unknown) => selection.selection(fresh === true));
  ipcMain.handle(IPC_CHANNELS.accountSelectPayer, (_event, organizationId: unknown) =>
    selection.select(organizationId)
  );
  return selection;
}

export { AccountService } from './AccountService';
