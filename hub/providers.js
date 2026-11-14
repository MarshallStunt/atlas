// AI providers. The conversation is kept in one canonical shape (Anthropic Messages blocks) and
// converted for OpenAI-compatible providers on each turn, so you can switch provider mid-chat.
// Two wire formats cover everyone:
//   - Anthropic Messages API, through the official SDK
//   - OpenAI-compatible chat completions (OpenAI, Gemini, xAI, Lambda, Groq, OpenRouter, Mistral, DeepSeek, Ollama, LM Studio)
import { cleanFetch } from './net.js';
import Anthropic from '@anthropic-ai/sdk';

// Default model lists (checked 2026-11-14 against each provider's live list or OpenRouter's catalogue).
// When a key is saved, the picker loads the provider's live list instead, filtered to chat models.
export const PROVIDERS = {
  anthropic:  { label: 'Anthropic Claude', kind: 'anthropic', env: 'ANTHROPIC_API_KEY', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] },
  openai:     { label: 'OpenAI', kind: 'openai', env: 'OPENAI_API_KEY', base: 'https://api.openai.com/v1', models: ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.5'] },
  google:     { label: 'Google Gemini', kind: 'openai', env: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-3.8-flash'] },
  xai:        { label: 'xAI Grok', kind: 'openai', env: 'XAI_API_KEY', base: 'https://api.x.ai/v1', models: ['grok-4.7', 'grok-4.6', 'grok-4.3', 'grok-build-0.1'] },
  lambda:     { label: 'Lambda Inference', kind: 'openai', env: 'LAMBDA_API_KEY', base: 'https://api.lambda.ai/v1', models: [] },
  groq:       { label: 'Groq', kind: 'openai', env: 'GROQ_API_KEY', base: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] },
  openrouter: { label: 'OpenRouter', kind: 'openai', env: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol', 'google/gemini-4-hydrogen', 'x-ai/grok-4.7'] },
  mistral:    { label: 'Mistral', kind: 'openai', env: 'MISTRAL_API_KEY', base: 'https://api.mistral.ai/v1', models: ['mistral-large-4', 'mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'] },
  deepseek:   { label: 'DeepSeek', kind: 'openai', env: 'DEEPSEEK_API_KEY', base: 'https://api.deepseek.com/v1', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
  ollama:     { label: 'Ollama (local)', kind: 'openai', local: true, base: 'http://localhost:11434/v1', models: [] },
  lmstudio:   { label: 'LM Studio (local)', kind: 'openai', local: true, base: 'http://localhost:1234/v1', models: [] },
};

// Live lists include speech, image, embedding and moderation models; the assistant needs chat models only.
const NOT_CHAT = /embed|tts|whisper|transcri|audio|realtime|image|dall-e|moderation|rerank|guard|ocr|voxtral|search|live|translate|vision-exp|banana|omni|veo|imagen|lyria|codex|:free|:batch|^babbage|^davinci|chatgpt-image/i;
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|0\d{3})$/;
const verKey = id => (String(id).match(/\d+(\.\d+)?/g) || []).map(Number);
function chatModels(ids) {
  const set = new Set(ids);
  return ids
    .filter(id => !NOT_CHAT.test(id))
    .filter(id => !(DATED.test(id) && set.has(id.replace(DATED, '')))) // keep the alias, drop its dated snapshots
    .sort((a, b) => { const x = verKey(a), y = verKey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0); } return a.localeCompare(b); });
}

export const keyFor = (s, p) => s.keys?.[p] || (p === 'anthropic' ? s.apiKey : '') || (PROVIDERS[p]?.env ? process.env[PROVIDERS[p].env] : '') || '';
export const baseFor = (s, p) => (s.baseUrls?.[p] || PROVIDERS[p]?.base || '').replace(/\/+$/, '');
export const isReady = (s, p) => !!(PROVIDERS[p]?.local || keyFor(s, p));

let anthropicFactory = s => new Anthropic({ ...(keyFor(s, 'anthropic') ? { apiKey: keyFor(s, 'anthropic') } : {}), fetch: cleanFetch });
export const setAnthropicFactory = fn => { anthropicFactory = fn; }; // tests

export async function listModels(s, p) {
  const def = PROVIDERS[p];
  if (!def) throw new Error('unknown provider');
  try {
    if (def.kind === 'anthropic') {
      const client = anthropicFactory(s); const ids = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids.length ? ids : def.models;
    }
    const r = await cleanFetch(baseFor(s, p) + '/models', { headers: keyFor(s, p) ? { Authorization: `Bearer ${keyFor(s, p)}` } : {}, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return def.models;
    const j = await r.json();
    const ids = (j.data || j.models || []).map(m => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
    const chat = def.local ? ids.filter(id => !/embed/i.test(id)) : chatModels(ids);
    return chat.length ? chat : def.models;
  } catch { return def.models; }
}

/* ---------------- Anthropic ---------------- */
const opts_effort = s => s.effortOverride || s.effort || 'low';
async function anthropicTurn({ s, model, system, messages, tools, emit }) {
  const client = anthropicFactory(s);
  const apiTools = tools.map((t, i) => ({ ...t, eager_input_streaming: true, ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }));
  const fallbackable = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
  const stream = client.beta.messages.stream({
    model, max_tokens: 16000,
    system: [{ type: 'text', text: system }],
    ...(apiTools.length ? { tools: apiTools } : {}), messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: opts_effort(s) },
    cache_control: { type: 'ephemeral' },
    ...(fallbackable ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  });
  stream.on('text', delta => emit({ type: 'text', delta }));
  const m = await stream.finalMessage();
  return { content: m.content, stop_reason: m.stop_reason };
}

/* ---------------- OpenAI-compatible ---------------- */
function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const results = blocks.filter(b => b.type === 'tool_result');
    const images = [];
    for (const r of results) {
      const parts = Array.isArray(r.content) ? r.content : [{ type: 'text', text: String(r.content ?? '') }];
      const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n') || (r.is_error ? 'error' : 'ok');
      parts.filter(p => p.type === 'image').forEach(p => images.push(`data:${p.source.media_type};base64,${p.source.data}`));
      out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: (r.is_error ? 'ERROR: ' : '') + text });
    }
    // Tool messages can't carry images, so a screenshot follows as a user message.
    if (images.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshot returned by the tool above:' }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] });
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

async function openaiTurn({ s, provider, model, system, messages, tools, emit }) {
  const key = keyFor(s, provider);
  const r = await cleanFetch(baseFor(s, provider) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model, stream: true, messages: toOpenAI(system, messages),
      ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
    }),
  });
  if (!r.ok) throw new Error(`${PROVIDERS[provider].label}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const dec = new TextDecoder(); let buf = '', text = '', finish = null;
  const calls = []; // by index
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      const ch = j.choices?.[0]; if (!ch) continue;
      const d = ch.delta || {};
      if (d.content) { text += d.content; emit({ type: 'text', delta: d.content }); }
      for (const tc of d.tool_calls || []) {
        const c = calls[tc.index ?? calls.length] ||= { id: '', name: '', args: '' };
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  calls.filter(Boolean).forEach((c, n) => {
    let input = {}; try { input = c.args ? JSON.parse(c.args) : {}; } catch { input = {}; }
    content.push({ type: 'tool_use', id: (c.id || `call_${Date.now()}_${n}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64), name: c.name, input });
  });
  const stop_reason = content.some(b => b.type === 'tool_use') ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
  return { content, stop_reason };
}

export function turn(opts) {
  const def = PROVIDERS[opts.provider];
  if (!def) throw new Error('Unknown AI provider ' + opts.provider);
  if (!isReady(opts.s, opts.provider)) throw new Error(`No API key for ${def.label} yet. Add one in System → Assistant.`);
  return def.kind === 'anthropic' ? anthropicTurn(opts) : openaiTurn(opts);
}
