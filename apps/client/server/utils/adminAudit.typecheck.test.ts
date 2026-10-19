import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const helperPath = fileURLToPath(new URL('./adminAudit.ts', import.meta.url));
const declarationsPath = fileURLToPath(new URL('./adminAudit.consumer.d.ts', import.meta.url));

// Isolate the consumer's request type from the client's ambient Express augmentation and the
// dependencies' own declaration graphs. Only the impersonation claim is intentionally absent.
const consumerDeclarations = `
declare module 'express' {
  export type User = {
    id: string;
    username: string;
    name: string;
    email?: string | null;
    isAdmin: boolean;
  };
  export type Request<P = unknown, R = unknown, B = unknown, Q = unknown, L = unknown> = {
    user?: User;
    apiKeyInfo?: { keyId: string };
    logger?: { error(message: string, meta: unknown): void };
    headers: { 'user-agent'?: string };
    requestId: string;
    url: string;
  };
}
declare module '@bike4mind/common' {
  export type AuditActor = {
    kind: 'user' | 'apiKey' | 'system';
    scope: 'platform' | 'organization';
    userId?: string;
    email?: string;
    name: string;
    wasAdmin: boolean;
    impersonatedUserId?: string;
    apiKeyId?: string;
  };
  export type AuditContext = {
    ip: string;
    userAgent?: string;
    requestId: string;
    route: string;
    source: 'api_key' | 'admin_ui';
  };
  export type AuditEntry = { id: string };
}
declare module '@bike4mind/database' {
  export const adminAuditLogRepository: unknown;
}
declare module '@bike4mind/database/auth' {
  export const userRepository: {
    findById(id: string): Promise<import('express').User | null>;
  };
}
declare module '@bike4mind/services' {
  export namespace adminAuditService {
    export type RecordAdminActionInput = {
      actor: import('@bike4mind/common').AuditActor;
      context: import('@bike4mind/common').AuditContext;
    };
    export function recordAdminAction(
      input: RecordAdminActionInput,
      adapters: unknown
    ): Promise<import('@bike4mind/common').AuditEntry | null>;
  }
}
declare module '@server/utils/ip' {
  export function getClientIp(req: import('express').Request): string;
}
`;

const checkConsumer = (helperSource: string) => {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const files = new Map([
    [helperPath, helperSource],
    [declarationsPath, consumerDeclarations],
  ]);
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = files.get(fileName);
    return source === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, source, languageVersion, true);
  };

  const program = ts.createProgram([helperPath, declarationsPath], options, host);
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
};

describe('admin audit consumer types', () => {
  it('compiles the helper without the client global declarations', () => {
    expect(checkConsumer(readFileSync(helperPath, 'utf8'))).toEqual([]);
  });

  it('detects reliance on a globally augmented impersonation claim', () => {
    const source = readFileSync(helperPath, 'utf8');
    const untypedRead = source.replace(/const \{ impersonatedBy \} = [^;]+;/, 'const { impersonatedBy } = user;');

    expect(untypedRead).not.toBe(source);
    expect(checkConsumer(untypedRead)).toEqual([
      { code: 2339, message: "Property 'impersonatedBy' does not exist on type 'User'." },
    ]);
  });
});
