import { performance } from 'node:perf_hooks';
import { parseObject, now } from './util.mjs';

export class DeepSeekClient {
  constructor({ key = process.env.DEEPSEEK_API_KEY, baseURL = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com', model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', budget, timeoutMs = 90000 } = {}) {
    if (!key) throw Object.assign(new Error('Configure DEEPSEEK_API_KEY in the runtime environment'), { code: 'MISSING_CREDENTIAL' });
    const url = new URL(baseURL);
    if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com') throw new Error('V1 live client only accepts official api.deepseek.com HTTPS endpoint');
    this.key = key; this.baseURL = baseURL.replace(/\/$/, ''); this.model = model; this.budget = budget; this.timeoutMs = timeoutMs;
  }
  async request(path, { body, signal } = {}) {
    const started = performance.now();
    const response = await fetch(this.baseURL + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(`DeepSeek HTTP ${response.status}: ${data.error?.message ?? 'request failed'}`);
      error.code = `PROVIDER_HTTP_${response.status}`; error.httpStatus = response.status; throw error;
    }
    return { data, duration_ms: Math.round(performance.now() - started), requested_model: this.model, timestamp: now() };
  }
  async probe() {
    const models = await this.request('/models');
    let balance;
    try { balance = (await this.request('/user/balance')).data; } catch (error) { balance = { available: false, reason: error.code }; }
    const chat = await this.chat([{ role: 'system', content: 'Return only a JSON object: {"ok":true}. This is a JSON capability check.' }, { role: 'user', content: 'Confirm connection.' }], { maxTokens: 64 });
    return { models: models.data.data?.map(model => model.id), selected_model: this.model, balance,
      chat: { ...chat, parsed: parseObject(chat.content) } };
  }
  async chat(messages, { maxTokens = 1600, json = true, signal, tools, toolChoice } = {}) {
    const ticket=this.budget?.reserve(Buffer.byteLength(JSON.stringify([messages,tools]))+maxTokens+2048);
    let result;try{result = await this.request('/chat/completions', { signal, body: {
      model: this.model, messages, temperature: 0,
      max_tokens: maxTokens, thinking: { type: 'disabled' },
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...(tools ? { tools, tool_choice: toolChoice ?? 'auto' } : {}),
    } });}catch(error){this.budget?.release(ticket);throw error;}
    const message = result.data.choices?.[0]?.message;
    this.budget?.usage(result.data.usage,ticket);
    return { content: message?.content ?? '', tool_calls: message?.tool_calls ?? [],
      finish_reason: result.data.choices?.[0]?.finish_reason, usage: result.data.usage,
      returned_model: result.data.model, duration_ms: result.duration_ms,
      requested_model: this.model, timestamp: result.timestamp };
  }
}
