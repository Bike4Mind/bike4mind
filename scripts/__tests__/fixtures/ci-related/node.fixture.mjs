import { expect, it, vi } from 'vitest';
import { value } from '@fixture/source';

vi.mock('@fixture/source', () => ({ value: 42 }));

it('loads the related source', () => expect(value).toBe(42));
