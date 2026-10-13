import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import rule, { ENTITY_BASE } from '../../eslint-rules/no-raw-entity-response.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(testDir, 'fixtures/no-raw-entity-response');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: fixtureDir },
  },
});

// Mirrors the real shapes: entities extend IMongoDocument, and `res` is Express-like.
const preamble = `
interface IMongoDocument { id: string; createdAt: Date; updatedAt: Date }
interface IUser { email: string; password: string }
interface IUserDocument extends IUser, IMongoDocument {}
interface IAdminDocument extends IUserDocument { scopes: string[] }
interface Res { status(code: number): Res; json(body?: unknown): Res; send(body?: unknown): Res }
declare const res: Res;
declare const user: IUserDocument;
declare const users: IUserDocument[];
declare const maybeUser: IUserDocument | null;
declare const maybeUsers: IUserDocument[] | null;
declare const pair: [IUserDocument, number];
declare const partial: Partial<IUserDocument>;
type FlattenMaps<T> = { [K in keyof T]: T[K] };
declare const leanRow: FlattenMaps<{ email: string }>;
declare const admin: IAdminDocument;
declare const safeUser: { id: string; email: string };
declare const projected: Pick<IUserDocument, 'id' | 'email'>;
declare const fetched: Response;
`;

const filename = path.join(fixtureDir, 'file.ts');
const valid = code => ({ code: preamble + code, filename });
const invalid = (code, method = 'json') => ({
  code: preamble + code,
  filename,
  errors: [{ messageId: 'rawEntity', data: { method } }],
});

ruleTester.run('no-raw-entity-response', rule, {
  valid: [
    valid('res.json(safeUser);'),
    valid('res.json(projected);'),
    valid('res.json({ success: true, id: user.id });'),
    valid('res.status(204).json();'),
    valid('fetched.json();'),
    valid('const other = { json(body: unknown) { return body; } }; other.json(user);'),
  ],
  invalid: [
    invalid('res.json(user);'),
    invalid('res.status(201).json(user);'),
    invalid('res.send(user);', 'send'),
    invalid('res.json(users);'),
    invalid('res.json(maybeUser);'),
    invalid('res.json(admin);'),
    invalid('res.json({ success: true, user });'),
    invalid('res.json({ ...user, extra: 1 });'),
    invalid('res.json(maybeUsers);'),
    invalid('res.json(pair);'),
    invalid('res.json(partial);'),
    invalid('res.json({ data: { owner: user } });'),
    invalid('res.json([user]);'),
    invalid('res.json(leanRow);'),
  ],
});

// The fixture declares its own IMongoDocument, so pin the rule's name to the real declaration.
describe('ENTITY_BASE', () => {
  it('matches the entity base interface in @bike4mind/common', () => {
    const source = readFileSync(path.join(testDir, '../../b4m-core/common/src/types/entities/common.ts'), 'utf8');
    expect(source).toMatch(new RegExp(`export interface ${ENTITY_BASE}\\b`));
  });
});
