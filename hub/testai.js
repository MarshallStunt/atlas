// "Test AI": real, tiny calls to the assistant, the voice and the listening service, timed, with the
// exact (secret-masked) headers that went out, so it's easy to see what works and how it looks.
import { getSettings } from './brain.js';
import * as providers from './providers.js';
import * as voice from './voice.js';
import { lastSent } from './net.js';

const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };

async function timed(fn) {
  const t0 = Date.now();
  try { const r = await fn(t0); return { ok: true, ms: Date.now() - t0, ...r }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300) }; }
}

export async function testAI({ provider, model, parts = ['chat', 'voice', 'listen'] } = {}) {
  const s = getSettings();
  provider ||= s.provider; model ||= s.model;
  const def = providers.PROVIDERS[provider];
  if (!def) throw new Error('Unknown provider');
  const results = [];
  let audio = null;

  if (parts.includes('chat')) {
    const r = await timed(async t0 => {
      let first = null, text = '';
      const out = await providers.turn({ s: { ...s, effortOverride: 'low' }, provider, model, tools: [],
        system: 'You are a connectivity check. Reply with exactly: OK',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        emit: ev => { if (ev.type === 'text') { first ??= Date.now() - t0; text += ev.delta; } } });
      text ||= out.content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (out.stop_reason === 'refusal') throw new Error('The model declined the request.');
      return { detail: `Replied "${text.trim().slice(0, 40)}"`, firstTokenMs: first };
    });
    results.push({ part: 'Assistant', target: `${def.label} · ${model}`, host: def.kind === 'anthropic' ? 'api.anthropic.com' : hostOf(providers.baseFor(s, provider)), ...r });
  }
  if (parts.includes('voice')) {
    const engine = voice.voiceEngine(s);
    if (engine === 'browser') results.push({ part: 'Voice (speaking)', target: 'phone voice', ok: false, ms: 0, error: 'No ElevenLabs or OpenAI key saved, so the phone\'s basic voice is used.' });
    else {
      const r = await timed(async () => { const out = await voice.synthesize('Atlas voice check. Everything sounds good.'); audio = out; return { detail: `${Math.round(out.audio.length / 1024)} KB of audio` }; });
      results.push({ part: 'Voice (speaking)', target: engine === 'openai' ? 'OpenAI gpt-4o-mini-tts' : 'ElevenLabs', host: engine === 'openai' ? 'api.openai.com' : 'api.elevenlabs.io', ...r });
    }
  }
  if (parts.includes('listen')) {
    if (voice.sttEngine(s) !== 'openai') results.push({ part: 'Voice (listening)', target: 'browser', ok: false, ms: 0, error: 'No OpenAI key saved, so the browser\'s own speech recognition is used.' });
    else {
      const r = await timed(async () => {
        const clip = audio || await voice.synthesize('Atlas voice check. Everything sounds good.').catch(() => null);
        if (!clip) throw new Error('Needs a voice key to make a test recording.');
        const text = await voice.transcribe(clip.audio, clip.type);
        return { detail: `Heard "${text.slice(0, 60)}"` };
      });
      results.push({ part: 'Voice (listening)', target: 'OpenAI gpt-transcribe', host: 'api.openai.com', ...r });
    }
  }
  const hosts = [...new Set(results.map(r => r.host).filter(Boolean))];
  return { at: Date.now(), results, headers: Object.fromEntries(hosts.filter(h => lastSent.has(h)).map(h => [h, lastSent.get(h)])) };
}
