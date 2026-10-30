/**
 * The AES-GCM associated data bound to a stored secret: its owner, the record it belongs to, and
 * the field it was written to. Writer and reader must build the identical string or decryption
 * fails closed, so every copy lives here - a hand-built duplicate in one call site silently breaks
 * every secret it touches.
 *
 * `isContextBound` reports whether a stored value is in the context-bound format; unbound
 * (pre-migration) values still decrypt without one.
 */
import { ciphertextVersionPrefix } from './secretEncryption';

const context = (...parts: string[]): string => JSON.stringify(parts);

/** A provider API key row: `ApiKey.userId`, the row's id, and its `apiKey` field. */
export const apiKeySecretContext = (userId: string, recordId: string): string =>
  context('ApiKey', userId, recordId, 'apiKey');

/** One MCP server env variable: `McpServer.userId`, the row's id, and the variable's name. */
export const mcpEnvSecretContext = (userId: string, recordId: string, key: string): string =>
  context('mcp', userId, recordId, key);

/** True when a stored value carries the context-bound ciphertext version. */
export const isContextBound = (value: string): boolean => value.startsWith(ciphertextVersionPrefix);
