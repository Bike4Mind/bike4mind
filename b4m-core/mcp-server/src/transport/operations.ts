import type { OperationId } from '@bike4mind/sdk';

export interface OperationDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Set when the route has a contract in `@bike4mind/sdk`; the stdio transport then sends it through the SDK. */
  sdkOperationId?: OperationId;
}

export const OPERATIONS = {
  listWhatsNew: { method: 'GET', path: '/api/v1/whats-new', sdkOperationId: 'listWhatsNew' },
  listModels: { method: 'GET', path: '/api/v1/models', sdkOperationId: 'listModels' },
  // No contract yet: the pending-action API lands separately, so path and id shape here are provisional.
  getMcpConfirmation: { method: 'GET', path: '/api/v1/mcp-confirmations/{id}' },
  withdrawMcpConfirmation: { method: 'DELETE', path: '/api/v1/mcp-confirmations/{id}' },
} as const satisfies Record<string, OperationDef>;

export type OperationName = keyof typeof OPERATIONS;
