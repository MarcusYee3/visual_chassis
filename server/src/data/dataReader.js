import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const JSON_PATH = join(__dirname, 'LionKing_two_weeks_tm2report_20260623183907.json');

let cachedRecords = null;

export function readRecords() {
  if (cachedRecords) return cachedRecords;

  const raw = readFileSync(JSON_PATH, 'utf-8');
  cachedRecords = JSON.parse(raw);

  return cachedRecords;
}

export function getRecordsBySerial(serialNumber) {
  return readRecords().filter(r => r['Serial Number'] === serialNumber);
}

export function getFailedRecords() {
  return readRecords().filter(r => r.ok === '0');
}

export function getPassedRecords() {
  return readRecords().filter(r => r.ok === '1');
}

export function getUniqueSerials() {
  return [...new Set(readRecords().map(r => r['Serial Number']))];
}
