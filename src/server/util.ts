import crypto from 'node:crypto';
import fs from 'node:fs';

export const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a);
export const sha1 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex');
export const newId = (prefix: string): string => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
export const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
/** The record behind an untrusted value, or an empty one, so property reads on parsed JSON are safe. */
export const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
export const firstLine = (s: string): string => s.split('\n')[0] ?? '';

export function loadJson(p: string, fallback: unknown): unknown {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
