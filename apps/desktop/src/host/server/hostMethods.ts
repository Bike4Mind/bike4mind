import {
  HOST_ERROR_CODES,
  HOST_PROTOCOL_VERSION,
  negotiateHostProtocol,
  type HostParams,
  type HostProtocolVersion,
  type HostResult,
} from '@shared/hostProtocol';
import type { HostAccount } from '../auth/hostAccount';
import type { HostControl } from './hostControl';
import { HostMethodError } from './HostMethodError';

export const hostControlMethods = ['host/initialize', 'host/info', 'host/auth/start', 'host/auth/status'] as const;
export type HostControlMethod = (typeof hostControlMethods)[number];

type HostControlHandlers = {
  [M in HostControlMethod]: (params: HostParams<M>) => Promise<HostResult<M>>;
};

const sameAccount = (a: HostAccount, b: HostAccount): boolean =>
  a === b || (a !== null && b !== null && a.userId === b.userId && a.environmentUrl === b.environmentUrl);

function requireControl(control: HostControl | undefined, method: HostControlMethod): HostControl {
  if (!control) throw new HostMethodError(HOST_ERROR_CODES.methodNotFound, `Method not found: ${method}`);
  return control;
}

async function info(control: HostControl, protocol: HostProtocolVersion): Promise<HostResult<'host/info'>> {
  return { ...(await control.facts()), protocol, account: control.account() };
}

/**
 * The `host/*` methods over one host's control port. `host/initialize` answers with the minor
 * both sides speak; a client of another major gets protocolMismatch, with `reason` saying which
 * side must update.
 */
export function hostControlHandlers(control: HostControl | undefined): HostControlHandlers {
  return {
    'host/initialize': async ({ protocol }) => {
      const host = requireControl(control, 'host/initialize');
      const negotiated = negotiateHostProtocol(protocol, HOST_PROTOCOL_VERSION);
      if (!negotiated.ok) {
        throw new HostMethodError(
          HOST_ERROR_CODES.protocolMismatch,
          `This host speaks protocol ${HOST_PROTOCOL_VERSION.major}.x; the client speaks ${protocol.major}.x`,
          { reason: negotiated.reason, host: HOST_PROTOCOL_VERSION }
        );
      }
      return info(host, { major: HOST_PROTOCOL_VERSION.major, minor: negotiated.minor });
    },
    'host/info': async () => info(requireControl(control, 'host/info'), HOST_PROTOCOL_VERSION),
    'host/auth/start': async () => {
      const host = requireControl(control, 'host/auth/start');
      if (!host.startSignIn) {
        throw new HostMethodError(HOST_ERROR_CODES.capabilityUnavailable, 'This host signs in through its own app', {
          capability: 'hostSignIn',
        });
      }
      return host.startSignIn();
    },
    'host/auth/status': async () => ({ account: requireControl(control, 'host/auth/status').account() }),
  };
}

/** Calls `push` once per change of account, starting from the account the host has now. */
export function watchHostAccount(control: HostControl, push: (account: HostAccount) => void): () => void {
  let last = control.account();
  return control.onAccountChanged(account => {
    if (sameAccount(account, last)) return;
    last = account;
    push(account);
  });
}
