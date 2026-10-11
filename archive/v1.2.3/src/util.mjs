import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const now = () => new Date().toISOString();
export const uid = prefix => `${prefix}-${randomUUID()}`;
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const clone = value => structuredClone(value);
export const canonical = value => Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const redact = value => JSON.parse(JSON.stringify(value).replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'));
export async function readJSON(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function writeJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(redact(value), null, 2) + '\n');
}
export async function readJSONL(path) {
  return (await readFile(path, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}
export function parseObject(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(trimmed);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected JSON object');
  return parsed;
}

export class Budget {
  constructor({ maxRequests = 1500, maxTokens = 2500000, deadlineMs = 3600000 } = {}) {
    this.maxRequests = maxRequests;
    this.maxTokens = maxTokens;
    this.deadline = Date.now() + deadlineMs;
    this.requests = 0;
    this.tokens = 0;
    this.reservations=new Map();
  }
  reserve(estimatedTokens=0) {
    const reserved=[...this.reservations.values()].reduce((a,b)=>a+b,0);
    if (this.requests >= this.maxRequests || this.tokens+reserved+estimatedTokens > this.maxTokens || this.tokens >= this.maxTokens || Date.now() >= this.deadline) {
      const error = new Error('Run budget exhausted'); error.code = 'BUDGET_EXHAUSTED'; throw error;
    }
    this.requests += 1;
    const ticket=uid('budget');this.reservations.set(ticket,estimatedTokens);return ticket;
  }
  usage(usage,ticket) { if(ticket)this.reservations.delete(ticket);this.tokens += usage?.total_tokens ?? usage?.totalTokens ?? ((usage?.input ?? 0) + (usage?.output ?? 0)); }
  release(ticket){this.reservations.delete(ticket);}
  snapshot() { return { requests: this.requests, tokens: this.tokens,reserved_tokens:[...this.reservations.values()].reduce((a,b)=>a+b,0), maxRequests: this.maxRequests, maxTokens: this.maxTokens }; }
}

export async function mapLimit(items, limit, callback, progress = () => {}) {
  const results = new Array(items.length);
  let next = 0, finished = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await callback(items[index], index); }
      catch (error) { results[index] = { case_id: items[index].case_id, error: { code: error.code ?? 'RUN_ERROR', message: error.message } }; }
      finished += 1;
      progress({ finished, total: items.length, result: results[index] });
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
