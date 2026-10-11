import { DeepSeekClient } from '../src/model.mjs';
import { Budget, writeJSON, now } from '../src/util.mjs';

try {
  const client = new DeepSeekClient({ budget: new Budget({ maxRequests: 3, maxTokens: 10000 }) });
  const result = await client.probe();
  const tool = await client.chat([{ role: 'system', content: 'Use the connection_check tool with ok=true.' },
    { role: 'user', content: 'Run the tool connection check.' }], {
    json: false, maxTokens: 128,
    tools: [{ type: 'function', function: { name: 'connection_check', description: 'Check tool calling connectivity', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } }],
    toolChoice: { type: 'function', function: { name: 'connection_check' } },
  });
  await writeJSON('reports/probe/connection.json', { timestamp: now(), ...result, tool });
  console.log(JSON.stringify({ connected: result.chat.parsed.ok === true, models: result.models,
    selected_model: result.selected_model, tool_calls: tool.tool_calls.map(call => call.function?.name),
    balance_available: result.balance.is_available ?? null, chat_usage: result.chat.usage, tool_usage: tool.usage }));
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? error.name, message: error.message }));
  process.exitCode = 1;
}
