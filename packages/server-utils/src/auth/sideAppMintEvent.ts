/**
 * Exact log message emitted once per our-fault mint refusal. The log metric filter in
 * infra/sideAppMintAlarms.ts matches the whole message, so this file has no imports: infra loads it
 * outside the app bundle.
 */
export const SIDE_APP_MINT_OUR_FAULT_EVENT = 'side-app-mint-our-fault';
