import { readFileSync } from 'node:fs';

export const readSource = file => readFileSync(file, 'utf8');
