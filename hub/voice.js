// Natural speech for replies. Order of preference: ElevenLabs (most human), OpenAI gpt-4o-mini-tts,
// then the phone's built-in voice (handled in the browser when neither has a key).
import { cleanFetch } from './net.js';
import { getSettings } from './brain.js';
import { keyFor } from './providers.js';

export const VOICES = {
  elevenlabs: [
    { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel — warm, calm' },
    { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah — soft, friendly' },
    { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam — deep, steady' },
    { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni — relaxed' },
    { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh — young, clear' },
  ],
  openai: [
    { id: 'coral', name: 'Coral — warm' }, { id: 'sage', name: 'Sage — calm' }, { id: 'verse', name: 'Verse — expressive' },
    { id: 'ash', name: 'Ash — low' }, { id: 'ballad', name: 'Ballad — gentle' }, { id: 'alloy', name: 'Alloy — neutral' },
  ],
};

const STYLE = 'Speak like a sharp, friendly human assistant talking to a colleague on the phone: natural pace, relaxed and warm, light emphasis on names and times, no announcer voice.';

export function voiceEngine(s = getSettings()) {
  const want = s.voiceEngine || 'auto';
  if (want === 'browser') return 'browser';
  if ((want === 'auto' || want === 'elevenlabs') && keyFor(s, 'elevenlabs')) return 'elevenlabs';
  if ((want === 'auto' || want === 'openai') && keyFor(s, 'openai')) return 'openai';
  return 'browser';
}

// Text written for the eye reads badly aloud: drop markdown, links and symbols.
export function speakable(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_#`>|]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

export async function synthesize(text) {
  const s = getSettings();
  const engine = voiceEngine(s);
  const input = speakable(text);
  if (!input) throw new Error('nothing to say');
  if (engine === 'elevenlabs') {
    const voice = /^[A-Za-z0-9]{20}$/.test(s.voice || '') ? s.voice : VOICES.elevenlabs[0].id;
    const r = await cleanFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': keyFor(s, 'elevenlabs'), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: input, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } }),
    });
    if (!r.ok) throw new Error(`ElevenLabs: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { audio: Buffer.from(await r.arrayBuffer()), type: 'audio/mpeg' };
  }
  if (engine === 'openai') {
    const voice = VOICES.openai.some(v => v.id === s.voice) ? s.voice : 'coral';
    const r = await cleanFetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyFor(s, 'openai')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input, instructions: STYLE, response_format: 'mp3' }),
    });
    if (!r.ok) throw new Error(`OpenAI voice: ${r.status} ${(await r.text()).slice(0, 200)}`);
    return { audio: Buffer.from(await r.arrayBuffer()), type: 'audio/mpeg' };
  }
  throw new Error('browser');
}

// Speech to text with OpenAI. Works in every browser (Web Speech doesn't exist in Brave, Firefox or
// most home-screen apps) and hears you out until you stop talking.
export const sttEngine = (s = getSettings()) => (s.sttEngine !== 'browser' && keyFor(s, 'openai') ? 'openai' : 'browser');

export async function transcribe(audio, mime) {
  const s = getSettings();
  if (sttEngine(s) !== 'openai') throw new Error('Voice input needs an OpenAI key (System → Voice).');
  const ext = /mpeg|mp3/.test(mime) ? 'mp3' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), `speech.${ext}`);
  form.append('prompt', 'A person talking to their work assistant about meetings, email, Slack, and their computer.');
  // gpt-transcribe is OpenAI's newest (and fastest in testing); fall back to the previous model if it's refused.
  let last = '';
  for (const model of ['gpt-transcribe', 'gpt-4o-mini-transcribe']) {
    form.set('model', model);
    const r = await cleanFetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${keyFor(s, 'openai')}` }, body: form });
    if (r.ok) return String((await r.json()).text || '').trim();
    last = `${r.status} ${(await r.text()).slice(0, 200)}`;
    if (r.status === 401 || r.status === 429) break;
  }
  throw new Error(`OpenAI transcription: ${last}`);
}
