import fs from 'fs';
import path from 'path';
import type { ModelCreditsData } from './slack';

const CREDITS_FILE = path.resolve(__dirname, '../fixtures/credits.json');

export function writeCreditsData(data: ModelCreditsData[]): void {
  fs.mkdirSync(path.dirname(CREDITS_FILE), { recursive: true });
  fs.writeFileSync(CREDITS_FILE, JSON.stringify(data, null, 2));
}

export function readCreditsData(): ModelCreditsData[] {
  try {
    if (!fs.existsSync(CREDITS_FILE)) return [];
    return JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}
