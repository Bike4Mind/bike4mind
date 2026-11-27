import { expect, it } from 'vitest';
import { value } from './source.fixture.mjs';

it('loads the related source in the second project', () => expect(value).toBe(42));
