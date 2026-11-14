// Aura phone UI. Everything from email, chat, calendar and the screen is untrusted text, so it is
// always escaped before it reaches the page.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = u => /^https?:\/\//i.test(String(u || '')) ? esc(u) : '#';
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
let state = null, view = 'now', inboxTab = 'mail', briefData = null, briefLoading = false;

/* ============================== API ============================== */
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ============================== time ============================== */
function rel(ms) {
  const d = ms - Date.now(), a = Math.abs(d), m = Math.round(a / 60000);
  const s = m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return s === 'now' ? 'now' : d > 0 ? `in ${s}` : `${s} ago`;
}
const short = ms => { const m = Math.round(Math.abs(Date.now() - ms) / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const isToday = ms => new Date(ms).toDateString() === new Date().toDateString();
function tick() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* ============================== icons ============================== */
const I = {
  meeting: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  computer: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  task: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  reply: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v5"/></svg>',
};
const icon = (name, size = 16) => I[name].replace('<svg', `<svg width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"`);

/* ============================== the orb ============================== */
// One animation loop draws every orb on the page; its look follows what Aura is doing.
const orb = { state: 'idle', level: 0, target: 0, canvases: [], t: 0 };
function addOrb(c) { if (c) orb.canvases.push({ c, ctx: c.getContext('2d') }); }
function setOrb(s) {
  orb.state = s;
  $('#stage-state').textContent = { idle: handsFree ? 'HANDS-FREE · TAP TO TALK' : 'TAP THE ORB TO TALK', listening: 'LISTENING', thinking: 'THINKING', speaking: 'SPEAKING · TAP TO INTERRUPT' }[s];
}
let analyser = null, levels = null;
function drawOrbs() {
  orb.t += 1 / 60;
  if (orb.state === 'speaking' && analyser) {
    analyser.getByteFrequencyData(levels);
    let sum = 0; for (let i = 2; i < 40; i++) sum += levels[i];
    orb.target = Math.min(1, sum / (38 * 150));
    if (!sum) orb.target = 0.45 + 0.25 * Math.sin(orb.t * 9); // phone voice: no audio data, animate anyway
  } else if (orb.state === 'listening') orb.target = Math.max(orb.target * 0.9, 0.12 + 0.05 * Math.sin(orb.t * 6));
  else if (orb.state === 'thinking') orb.target = 0.35;
  else orb.target = 0.12 + 0.05 * Math.sin(orb.t * 1.4);
  orb.level += (orb.target - orb.level) * 0.18;
  for (const { c, ctx } of orb.canvases) {
    if (!c.offsetParent) continue;
    const w = c.width, h = c.height, cx = w / 2, cy = h / 2, R = w * 0.28;
    ctx.clearRect(0, 0, w, h);
    const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.9);
    g.addColorStop(0, `rgba(34,211,238,${0.18 + orb.level * 0.25})`); g.addColorStop(0.5, 'rgba(167,139,250,.08)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // dark glass core, then three drifting colour lobes so the cyan / violet / pink stay distinct
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.05);
    core.addColorStop(0, '#101a33'); core.addColorStop(1, '#070b16');
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, R * 0.98, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    for (const [color, ph] of [['#22d3ee', 0], ['#8b5cf6', 2.1], ['#ec4899', 4.2]]) {
      const ox = cx + Math.cos(orb.t * 0.6 + ph) * R * 0.32, oy = cy + Math.sin(orb.t * 0.8 + ph) * R * 0.32;
      ctx.beginPath();
      const N = 72, amp = 0.06 + orb.level * 0.3;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const n = Math.sin(a * 3 + orb.t * 1.3 + ph) * 0.5 + Math.sin(a * 5 - orb.t * 1.9 + ph * 1.7) * 0.3 + Math.sin(a * 2 + orb.t * 0.7) * 0.2;
        const r = R * (0.92 + amp * n);
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      const fg = ctx.createRadialGradient(ox, oy, 0, ox, oy, R * 0.95);
      fg.addColorStop(0, color + 'bb'); fg.addColorStop(0.55, color + '40'); fg.addColorStop(1, color + '00');
      ctx.fillStyle = fg; ctx.fill();
    }
    // rim light
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(165,243,252,${0.25 + orb.level * 0.4})`; ctx.lineWidth = Math.max(1, w / 200);
    ctx.beginPath(); ctx.arc(cx, cy, R * (0.95 + orb.level * 0.08), 0, Math.PI * 2); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    const hl = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, 0, cx - R * 0.35, cy - R * 0.4, R * 0.6);
    hl.addColorStop(0, 'rgba(255,255,255,.22)'); hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl; ctx.beginPath(); ctx.arc(cx, cy, R * 0.95, 0, Math.PI * 2); ctx.fill();
    if (orb.state === 'thinking') {
      ctx.lineWidth = Math.max(1.5, w / 160); ctx.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = ['rgba(34,211,238,.9)', 'rgba(167,139,250,.8)', 'rgba(244,114,182,.7)'][k];
        ctx.beginPath(); const s = orb.t * (1.6 + k * 0.7) * (k % 2 ? -1 : 1);
        ctx.arc(cx, cy, R * (1.25 + k * 0.13), s, s + 1.1 + k * 0.4); ctx.stroke();
      }
    }
    if (orb.state === 'listening') {
      ctx.strokeStyle = `rgba(34,211,238,${0.25 + orb.level * 0.5})`; ctx.lineWidth = Math.max(1, w / 220);
      for (let k = 0; k < 2; k++) { const p = ((orb.t * 0.8 + k * 0.5) % 1); ctx.globalAlpha = 1 - p; ctx.beginPath(); ctx.arc(cx, cy, R * (1.1 + p * 0.7), 0, Math.PI * 2); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
  }
  requestAnimationFrame(drawOrbs);
}

/* ============================== voice out ============================== */
// Natural speech from the hub (ElevenLabs / OpenAI), played sentence by sentence as the reply streams in.
let audioCtx = null, voiceOn = true, handsFree = false;
const voiceEl = $('#voice-out');
function unlockAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(voiceEl);
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 128; levels = new Uint8Array(analyser.frequencyBinCount);
      src.connect(analyser); analyser.connect(audioCtx.destination);
    } catch {}
  }
  audioCtx?.resume?.();
  // iOS only lets audio play after a tap: prime the element inside this gesture with a short silent clip.
  if (!voiceEl.dataset.primed) {
    voiceEl.dataset.primed = '1';
    const ctx = audioCtx; if (ctx) { const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); }
    voiceEl.muted = true; voiceEl.play().catch(() => {}).finally(() => { voiceEl.pause(); voiceEl.muted = false; });
  }
}
const speaker = {
  queue: [], playing: false, gen: 0, browserVoice: null,
  say(text) {
    text = String(text).trim(); if (!text) return;
    const engine = state?.settings?.activeVoice || 'browser';
    const audio = engine === 'browser' ? null
      : fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
        .then(async r => r.status === 200 ? URL.createObjectURL(await r.blob()) : null).catch(() => null);
    this.queue.push({ text, audio });
    if (!this.playing) this.next(this.gen);
  },
  async next(gen) {
    if (gen !== this.gen) return;
    const item = this.queue.shift();
    if (!item) { this.playing = false; if (orb.state === 'speaking') setOrb('idle'); setTimeout(() => { if (!this.playing && !sending && !listening) $('#stage-live').textContent = ''; }, 2500); afterSpeaking(); return; }
    this.playing = true; setOrb('speaking');
    const url = item.audio ? await item.audio : null;
    if (gen !== this.gen) return;
    if (url) {
      voiceEl.src = url;
      voiceEl.onended = () => { URL.revokeObjectURL(url); this.next(gen); };
      voiceEl.onerror = () => this.next(gen);
      voiceEl.play().catch(() => this.browserSpeak(item.text, gen));
    } else this.browserSpeak(item.text, gen);
  },
  browserSpeak(text, gen) {
    if (!('speechSynthesis' in window)) return this.next(gen);
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>]/g, ''));
    this.browserVoice ||= bestBrowserVoice();
    if (this.browserVoice) u.voice = this.browserVoice;
    u.rate = 1.02;
    u.onend = u.onerror = () => this.next(gen);
    speechSynthesis.speak(u);
  },
  stop() { this.gen++; this.queue = []; this.playing = false; voiceEl.pause(); if ('speechSynthesis' in window) speechSynthesis.cancel(); if (orb.state === 'speaking') setOrb('idle'); },
};
function bestBrowserVoice() {
  const vs = speechSynthesis.getVoices().filter(v => v.lang?.startsWith((navigator.language || 'en').slice(0, 2)));
  const score = v => (/premium|enhanced|natural|neural/i.test(v.name) ? 10 : 0) + (/siri|samantha|ava|zoe|google us english|aria|jenny/i.test(v.name) ? 5 : 0) + (v.localService ? 1 : 0);
  return vs.sort((a, b) => score(b) - score(a))[0] || null;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { speaker.browserVoice = null; };

// Split a streaming reply into sentences so speech starts before the reply is finished.
function sentenceSplitter(onSentence) {
  let buf = '', first = true;
  return {
    push(t) {
      buf += t;
      for (;;) {
        const min = first ? 12 : 40;
        const m = buf.slice(min).match(/[.!?…](\s|$)|\n/);
        if (!m) break;
        const cut = min + m.index + 1;
        onSentence(buf.slice(0, cut)); buf = buf.slice(cut); first = false;
      }
    },
    flush() { if (buf.trim()) onSentence(buf); buf = ''; },
  };
}

/* ============================== voice in ============================== */
// With an OpenAI key: record from the mic, watch the level to tell when you've finished talking,
// then transcribe on the hub. Without one: the browser's own speech recognition.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let listening = false, stopListening = null;
const SILENCE_MS = 1300, NO_SPEECH_MS = 8000, MAX_MS = 45000;

function startListening() {
  unlockAudio();
  speaker.stop();
  if (listening) { stopListening?.(); return; }
  if (!window.isSecureContext) { $('#ask-input').focus(); toast('Talking needs a secure (https) page, so on this device type below instead. Replies are still spoken.'); return; }
  const useServer = state?.settings?.stt === 'openai' && audioCtx && navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
  if (useServer) return recordAndTranscribe();
  if (SR) return browserRecognition();
  $('#ask-input').focus();
  toast(!window.isSecureContext ? 'Talking needs a secure (https) page, so on this device type below instead. Replies are still spoken.'
    : 'This browser has no speech recognition. Add an OpenAI key in System → Voice and voice works everywhere.');
}

async function recordAndTranscribe() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser settings for this site.' : 'No microphone available: ' + e.message); setOrb('idle'); return; }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  const src = audioCtx.createMediaStreamSource(stream);
  const mic = audioCtx.createAnalyser(); mic.fftSize = 1024; src.connect(mic);
  const buf = new Float32Array(mic.fftSize);
  const started = Date.now();
  let floor = 0.01, heard = false, lastVoice = 0, done = false, cancelled = false;

  listening = true; setOrb('listening'); $('#stage-live').textContent = 'Listening…'; navigator.vibrate?.(12);
  recorder.start(250);
  const timer = setInterval(() => {
    mic.getFloatTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length), now = Date.now();
    if (now - started < 350) floor = Math.max(floor * 0.7, rms); // learn the room noise for a moment
    const loud = rms > Math.max(0.015, floor * 2.8);
    orb.target = Math.min(1, rms * 9);
    if (loud) { heard = true; lastVoice = now; }
    if (heard && now - lastVoice > SILENCE_MS) finish();
    else if (!heard && now - started > NO_SPEECH_MS) { cancelled = true; finish(); }
    else if (now - started > MAX_MS) finish();
  }, 60);

  function finish() {
    if (done) return; done = true;
    clearInterval(timer);
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); src.disconnect();
      listening = false; stopListening = null;
      if (cancelled || !heard) { setOrb('idle'); $('#stage-live').textContent = ''; if (!handsFree) toast('I didn\'t hear anything.'); return; }
      setOrb('thinking'); $('#stage-live').textContent = 'Got it…';
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
        const r = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (!j.text) { setOrb('idle'); $('#stage-live').textContent = ''; toast('I didn\'t catch that.'); return; }
        $('#stage-live').textContent = j.text;
        send(j.text, { voice: true });
      } catch (e) { setOrb('idle'); $('#stage-live').textContent = ''; toast(e.message); }
    };
    recorder.stop();
  }
  // Tapping the orb again means "I'm done": send what was said straight away.
  stopListening = () => { if (!heard) cancelled = true; finish(); };
}

function browserRecognition() {
  const rec = new SR();
  rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = true;
  let finalText = '', interim = '', silence = null, ended = false;
  const done = () => { if (!ended) { ended = true; clearTimeout(silence); try { rec.stop(); } catch {} } };
  const arm = ms => { clearTimeout(silence); silence = setTimeout(done, ms); };
  rec.onresult = e => {
    finalText = ''; interim = '';
    for (const r of e.results) r.isFinal ? (finalText += r[0].transcript) : (interim += r[0].transcript);
    $('#stage-live').textContent = (finalText + ' ' + interim).trim();
    orb.target = 0.9;
    arm(SILENCE_MS + 300); // wait for a real pause, not the first breath
  };
  rec.onerror = e => {
    const msg = { 'not-allowed': 'Microphone access was blocked.', 'service-not-allowed': 'Speech recognition is blocked in this browser.', network: 'This browser can\'t reach its speech service (Brave blocks it). Add an OpenAI key in System → Voice, or use Chrome or Safari.', 'audio-capture': 'No microphone found.' }[e.error];
    if (msg) toast(msg);
  };
  rec.onend = () => {
    listening = false; stopListening = null; clearTimeout(silence);
    const text = (finalText + ' ' + interim).trim();
    if (text) send(text, { voice: true });
    else { setOrb('idle'); $('#stage-live').textContent = ''; }
  };
  try { rec.start(); listening = true; stopListening = done; setOrb('listening'); $('#stage-live').textContent = 'Listening…'; arm(NO_SPEECH_MS); navigator.vibrate?.(12); }
  catch { listening = false; setOrb('idle'); }
}

function afterSpeaking() {
  if (handsFree && !sending && view === 'talk') setTimeout(() => { if (!listening && !sending && !speaker.playing) startListening(); }, 450);
}
function orbTap() {
  if (view !== 'talk') switchView('talk');
  if (orb.state === 'speaking') { speaker.stop(); return startListening(); }
  startListening();
}

/* ============================== sign-in ============================== */
let setupMode = false, booted = false;
async function boot() {
  addOrb($('#login-orb')); addOrb($('#dock-orb')); addOrb($('#stage-orb'));
  requestAnimationFrame(drawOrbs);
  const s = await fetch('/api/session').then(r => r.json());
  s.authed ? showMain() : showLogin(s);
}
function showLogin(s = {}) {
  $('#main').hidden = true; $('#login').hidden = false;
  setupMode = !!s.canSetup;
  $('#pin2').hidden = !setupMode;
  $('#setup-code').hidden = !s.needsSetupCode;
  $('#login-btn').textContent = setupMode ? 'Set PIN' : 'Unlock';
  $('#login-hint').textContent = setupMode ? 'Choose a 6–12 digit PIN' : s.needsSetup ? 'Set up Aura from the computer first: open http://127.0.0.1:8100 there.' : 'Enter your PIN';
}
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault(); $('#login-error').textContent = '';
  const pin = $('#pin').value.trim();
  try {
    if (setupMode) { if (pin !== $('#pin2').value.trim()) throw new Error('The PINs don\'t match.'); await api('/api/setup', { method: 'POST', body: { pin, setupCode: $('#setup-code').value.trim() } }); }
    else await api('/api/login', { method: 'POST', body: { pin } });
    $('#pin').value = $('#pin2').value = ''; showMain();
  } catch (err) { $('#login-error').textContent = err.message; }
});
async function showMain() {
  $('#login').hidden = true; $('#main').hidden = false;
  if (booted) return refresh(); booted = true;
  tick(); setInterval(tick, 15000);
  await refresh();
  loadBrief();
  loadHistory();
  api('/api/connections').then(d => { connData = d; if (view === 'now') renderNow(); }).catch(() => {});
  setInterval(() => document.visibilityState === 'visible' && api('/api/connections').then(d => { connData = d; if (view === 'now') renderNow(); if (view === 'system') renderConnections(); }).catch(() => {}), 60000);
  setInterval(() => document.visibilityState === 'visible' && refresh(true), 20000);
  setInterval(() => document.visibilityState === 'visible' && loadBrief(), 5 * 60000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh(true));
}

/* ============================== state ============================== */
async function refresh(background = false) {
  try { state = await api('/api/state'); } catch { return; }
  voiceOn = state.settings.voiceReplies; handsFree = state.settings.handsFree;
  $('#speak-toggle').setAttribute('aria-pressed', voiceOn); $('#hands-free').setAttribute('aria-pressed', handsFree);
  if (orb.state === 'idle') setOrb('idle');
  renderHeader(); renderApprovals();
  if (view === 'now' && !document.querySelector('#view-now input:focus')) renderNow();
  if (view === 'system' && !background) renderSystem();
}
const device = () => state?.devices.find(d => d.selected);
const PLAT = { darwin: 'macOS', win32: 'Windows', linux: 'Linux', macOS: 'macOS', Windows: 'Windows', Linux: 'Linux' };
function renderHeader() {
  const d = device();
  $('#device-name').textContent = d ? d.name : 'No computer';
  $('#device-meta').textContent = d ? (d.online ? PLAT[d.platform] || d.platform : 'OFFLINE') : '';
  $('#sys-pill .dot').classList.toggle('on', !!d?.online);
}

let lastApprovalIds = '';
function renderApprovals() {
  const list = state?.approvals || [];
  const ids = list.map(a => a.id).join();
  if (ids && ids !== lastApprovalIds && voiceOn && audioCtx) speaker.say(`I need your okay to ${list[0].summary.charAt(0).toLowerCase() + list[0].summary.slice(1)}.`);
  lastApprovalIds = ids;
  $('#approvals').innerHTML = list.map(a => `
    <div class="approval" data-id="${esc(a.id)}">
      <div class="label">⚠ Needs your approval</div>
      <h3>${esc(a.summary)}</h3>
      <pre>${esc(a.tool === 'slack_send' ? `To: ${a.input.to}\n\n${a.input.text}` : a.tool === 'run_command' ? `$ ${a.input.command}` : a.tool === 'browser_act' ? `${a.input.action} [${a.input.ref}]${a.input.text ? `\n\n${a.input.text}` : ''}` : JSON.stringify(a.input, null, 2))}</pre>
      <div class="row-actions"><button class="btn glow" data-approve="1">Approve</button><button class="btn" data-approve="0">Deny</button></div>
    </div>`).join('');
}
$('#approvals').addEventListener('click', async e => {
  const b = e.target.closest('[data-approve]'); if (!b) return;
  const card = b.closest('.approval'); card.querySelectorAll('button').forEach(x => x.disabled = true);
  try { await api(`/api/approvals/${card.dataset.id}`, { method: 'POST', body: { approve: b.dataset.approve === '1' } }); toast(b.dataset.approve === '1' ? 'Approved' : 'Denied'); }
  catch (err) { toast(err.message); }
  refresh(true);
});

/* ============================== briefing ============================== */
async function loadBrief(force = false) {
  if (briefLoading) return;
  briefLoading = true; if (view === 'now') renderNow();
  try { const b = await api(`/api/brief?tz=${encodeURIComponent(tz)}${force ? '&force=1' : ''}`); if (!b.pending) briefData = b; }
  catch (e) { briefData = { error: e.message }; }
  briefLoading = false; if (view === 'now') renderNow();
  renderSuggestions();
}

/* ============================== NOW ============================== */
const avatarColor = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return `linear-gradient(135deg, hsl(${h} 85% 68%), hsl(${(h + 50) % 360} 85% 60%))`; };
const initials = s => String(s || '?').replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
function greeting() { const h = new Date().getHours(); return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

function renderNow() {
  const el = $('#view-now');
  const d = device(), snap = state?.snapshot;
  const parts = [];
  const comp = snap?.computer || {}, inbox = snap?.inbox || {};
  const unread = inbox.gmail?.unread || 0, mentions = (inbox.slack?.mentions || []).length;
  parts.push(`<div class="hello"><h1>${greeting()}<span class="grad-text">.</span></h1>
    <div class="sub">${esc(new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))}${connData && !connData.error ? ` · <button class="conn-chip ${((connData.counts.error || 0) + (connData.counts.warn || 0)) ? 'bad' : ''}" data-goto="system">${((connData.counts.error || 0) + (connData.counts.warn || 0)) ? ((connData.counts.error || 0) + (connData.counts.warn || 0)) + ' to fix' : 'all connected'}</button>` : ''}${snap ? ` · ${unread} unread · ${mentions} mentions` : ''}</div></div>`);

  if (!d) {
    parts.push(`<div class="panel edge brief"><h2>Pair your computer</h2><p class="dim">On the computer, run the Aura installer. It shows a code; enter it under System.</p><div class="row-actions"><button class="btn glow" data-goto="system">Open System</button></div></div>`);
    el.innerHTML = parts.join(''); return;
  }

  // AI briefing
  const b = briefData;
  if (briefLoading && !b) parts.push(`<div class="panel edge brief"><div class="panel-head"><span class="label">${icon('spark', 13)} Briefing</span><span class="mono dim" style="font-size:11px">THINKING…</span></div><div class="shimmer" style="width:80%"></div><div class="shimmer" style="width:60%"></div><div class="shimmer" style="width:70%"></div></div>`);
  else if (b && !b.error) {
    parts.push(`<div class="panel edge brief ${esc(b.mood)}">
      <div class="panel-head"><span class="label">${icon('spark', 13)} Briefing <span class="mood ${esc(b.mood)}">${esc(b.mood.toUpperCase())}</span></span><button class="icon-btn" data-brief-refresh aria-label="Refresh briefing">${I.refresh}</button></div>
      <h2>${esc(b.headline)}</h2>
      ${b.items.map((it, i) => `<div class="brief-item"><div class="ico ${esc(it.kind)}">${I[it.kind] || I.task}</div><div><div class="t">${esc(it.text)}</div><div class="w">${esc(it.why)}</div></div>${it.action.label && (it.action.ask || it.action.url) ? `<button class="btn sm" data-brief="${i}">${esc(it.action.label)}</button>` : '<span></span>'}</div>`).join('')}
    </div>`);
  } else if (b?.error) parts.push(`<div class="panel brief"><div class="panel-head"><span class="label">${icon('spark', 13)} Briefing</span><button class="icon-btn" data-brief-refresh aria-label="Retry">${I.refresh}</button></div><p class="dim">${esc(b.error)}</p></div>`);

  if (!snap) { parts.push(`<div class="panel"><p class="dim">Waiting for the first update from ${esc(d.name)}…</p></div>`); el.innerHTML = parts.join(''); return; }

  // Next meeting with countdown ring
  const now = Date.now();
  const timed = (inbox.calendar?.events || []).filter(e => e.at && !e.allDay);
  const next = timed.find(e => e.at > now - 15 * 60000);
  if (next) {
    const live = next.at <= now, mins = Math.max(0, Math.round((next.at - now) / 60000));
    const frac = live ? 1 : Math.max(0.03, 1 - Math.min(mins, 60) / 60), C = 2 * Math.PI * 40;
    parts.push(`<div class="panel"><div class="panel-head"><span class="label">${live ? '<span class="live-tag">● LIVE</span>' : 'Next up'}</span>${comp.inCall ? `<span class="live-tag">IN ${esc(comp.inCall).toUpperCase()} CALL</span>` : ''}</div>
      <div class="meet"><div class="ring"><svg viewBox="0 0 92 92"><defs><linearGradient id="ringGrad"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><circle class="track" cx="46" cy="46" r="40"/><circle class="bar" cx="46" cy="46" r="40" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - frac)}"/></svg>
        <div class="center"><div><b>${live ? 'NOW' : mins >= 60 ? Math.round(mins / 60) + 'h' : mins}</b><small>${live ? 'started' : mins >= 60 ? 'hours' : 'min'}</small></div></div></div>
        <div><h3>${esc(next.title)}</h3><div class="when">${esc(clock(next.at))}${isToday(next.at) ? '' : ' · ' + esc(next.date)}</div></div></div>
      <div class="row-actions"><button class="btn glow sm" data-open="${esc(next.link)}">Open on computer</button><button class="btn sm" data-ask="${esc(`Prep me for my meeting "${next.title}": what is it about, and is there anything in my email or Slack I should know first?`)}">Prep me</button><a class="btn sm ghost" href="${safeHref(next.link)}" target="_blank" rel="noopener">Open here</a></div></div>`);
  }

  // Timeline
  const today = (inbox.calendar?.events || []).filter(e => e.at && isToday(e.at));
  if (inbox.calendar) {
    let nowPlaced = false;
    const rows = today.map(e => {
      let pre = '';
      if (!nowPlaced && !e.allDay && e.at > now) { nowPlaced = true; pre = `<div class="tl-now"><span>NOW</span></div>`; }
      const cls = !e.allDay && e.at < now - 45 * 60000 ? 'past' : !e.allDay && e.at <= now ? 'now' : '';
      return pre + `<a class="tl-item ${cls}" href="${safeHref(e.link)}" target="_blank" rel="noopener"><div class="tm">${esc(e.allDay ? 'ALL DAY' : clock(e.at))}</div><div>${esc(e.title)}</div></a>`;
    }).join('');
    parts.push(`<div class="panel"><div class="panel-head"><span class="label">Today <span class="n">${today.length}</span></span></div>${today.length ? `<div class="tl">${rows}${nowPlaced ? '' : '<div class="tl-now"><span>NOW</span></div>'}</div>` : '<div class="empty">Clear calendar today.</div>'}</div>`);
  }

  // Inbox (mail / chat)
  const mails = inbox.gmail?.latest || [], chats = inbox.slack?.mentions || [];
  const list = inboxTab === 'mail'
    ? mails.slice(0, 7).map((m, i) => `<div class="msg-item" data-mail="${i}"><div class="avatar" style="background:${avatarColor(m.from || m.fromEmail)}">${esc(initials(m.from || m.fromEmail))}</div><div style="min-width:0"><div class="who">${esc(m.from || m.fromEmail)}</div><div class="subj">${esc(m.subject)}</div><div class="snip">${esc(m.snippet)}</div></div><div class="ago">${esc(short(m.at))}</div></div>`).join('') || '<div class="empty">Inbox zero. ✨</div>'
    : chats.slice(0, 7).map((m, i) => `<div class="msg-item" data-chat="${i}"><div class="avatar" style="background:${avatarColor(m.user)}">${esc(initials(m.user))}</div><div style="min-width:0"><div class="who">${esc(m.user)} <span class="dim" style="font-weight:400">${m.isDm ? '· DM' : m.channel ? '· #' + esc(m.channel) : ''}</span></div><div class="snip" style="color:var(--text)">${esc(m.text)}</div></div><div class="ago">${esc(short(m.at))}</div></div>`).join('') || '<div class="empty">No mentions in the last 2 days.</div>';
  parts.push(`<div class="panel"><div class="panel-head"><div class="seg"><button data-seg="mail" class="${inboxTab === 'mail' ? 'on' : ''}">Mail <b>${unread}</b></button><button data-seg="chat" class="${inboxTab === 'chat' ? 'on' : ''}">Slack <b>${mentions}</b></button></div>
    <button class="btn sm" data-ask="${inboxTab === 'mail' ? 'Go through my unread email: who needs what from me, and what can wait?' : 'What do people need from me on Slack? Most urgent first.'}">${icon('spark', 13)} Triage</button></div>
    ${list}</div>`);

  const errs = Object.entries(inbox.errors || {});
  if (inbox.connected === false || inbox.note) parts.push(`<div class="panel"><div class="label">Web apps</div><p class="dim">${esc(inbox.note || 'The browser extension hasn\'t sent fresh data. Open Chrome, Edge or Brave on the computer.')}</p></div>`);
  else if (errs.length) parts.push(`<div class="panel"><div class="label">Sync</div>${errs.map(([k, v]) => `<p class="dim" style="margin:6px 0">${esc(k)}: ${esc(v)}</p>`).join('')}</div>`);

  // System HUD
  if (comp.host) {
    const gauge = (val, label, color, txt) => { const C = 2 * Math.PI * 22; return `<div class="gauge"><svg viewBox="0 0 54 54"><circle class="track" cx="27" cy="27" r="22"/><circle class="bar" cx="27" cy="27" r="22" stroke="${color}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - Math.max(0, Math.min(1, val)))}"/></svg><b>${esc(txt)}</b><small>${esc(label)}</small></div>`; };
    const bt = comp.battery, dk = comp.disk;
    const idle = comp.idleSeconds == null ? '—' : comp.idleSeconds < 60 ? 'active now' : `away ${short(Date.now() - comp.idleSeconds * 1000)}`;
    parts.push(`<div class="panel"><div class="panel-head"><span class="label">${esc(comp.host)} · ${esc(comp.platform)}</span><span class="mono dim" style="font-size:11px">UP ${esc(comp.uptimeHours)}H</span></div>
      <div class="hud">
        ${bt ? gauge(bt.percent / 100, bt.onAC ? 'charging' : 'battery', bt.percent < 20 ? '#fb7185' : '#a3e635', bt.percent + '%') : gauge(1, 'power', '#a3e635', 'AC')}
        ${gauge(comp.memoryUsedPct / 100, 'memory', comp.memoryUsedPct > 90 ? '#fbbf24' : '#22d3ee', comp.memoryUsedPct + '%')}
        ${dk ? gauge(1 - dk.freeGB / dk.totalGB, 'disk free', '#a78bfa', Math.round(dk.freeGB) + 'G') : ''}
        ${gauge(comp.idleSeconds == null ? 0 : comp.idleSeconds < 60 ? 1 : Math.max(0.05, 1 - comp.idleSeconds / 3600), 'presence', '#f472b6', comp.idleSeconds != null && comp.idleSeconds < 60 ? 'ON' : 'AWAY')}
      </div>
      <div class="kv" style="margin-top:10px"><span>Front</span><span>${esc(comp.frontWindow || '—')}</span></div>
      <div class="kv"><span>User</span><span>${esc(idle)}</span></div>
      <div class="chips">${(comp.apps || []).slice(0, 12).map(a => `<span class="chip">${esc(a)}</span>`).join('')}</div>
      <div class="quick"><button class="qbtn" data-action="lock_computer">${I.lock}Lock</button><button class="qbtn" data-notify>${I.bell}Notify</button><button class="qbtn" data-goto="screen">${I.eye}Screen</button></div></div>`);
  }

  // Notes
  const notes = state.notes || [];
  parts.push(`<div class="panel"><div class="panel-head"><span class="label">Notes <span class="n">${notes.filter(n => !n.done).length}</span></span></div>
    ${notes.slice(0, 10).map(n => `<div class="note ${n.done ? 'done' : ''}" data-note="${esc(n.id)}"><button class="check" aria-label="Done"></button><span>${esc(n.text)}</span><button class="icon-btn" data-del aria-label="Delete">✕</button></div>`).join('')}
    <form class="inline-form" id="note-form"><input id="note-input" placeholder="Add a note…"><button class="btn sm">Add</button></form></div>`);

  el.innerHTML = parts.join('');
}

function openSheet(html) { $('#sheet-card').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

function itemSheet(kind, m) {
  const who = kind === 'mail' ? (m.from || m.fromEmail) : m.user;
  const title = kind === 'mail' ? m.subject : (m.isDm ? 'Direct message' : '#' + m.channel);
  const body = kind === 'mail' ? m.snippet : m.text;
  const replyAsk = kind === 'mail'
    ? `Draft a reply to ${who}${m.fromEmail ? ` <${m.fromEmail}>` : ''} about "${m.subject}". Read the email first, keep it short, and open it as a draft on my computer.`
    : `Reply to ${who} on Slack about: "${String(m.text).slice(0, 160)}". Suggest a short reply and send it after I approve.`;
  const sumAsk = kind === 'mail'
    ? `Open and read the email "${m.subject}" from ${who}, summarize it in two sentences and tell me what they need.`
    : `Summarize the Slack conversation around ${who}'s message "${String(m.text).slice(0, 120)}" and tell me what they need.`;
  openSheet(`<div style="display:flex;gap:12px;align-items:center"><div class="avatar" style="background:${avatarColor(who)}">${esc(initials(who))}</div><div><h3>${esc(who)}</h3><div class="dim" style="font-size:13px">${esc(title)} · ${esc(rel(m.at))}</div></div></div>
    <div class="body">${esc(body)}</div>
    <div class="sheet-actions">
      <button class="btn glow" data-ask="${esc(replyAsk)}">${icon('reply')} Draft a reply with Aura</button>
      <button class="btn" data-ask="${esc(sumAsk)}">${icon('spark')} Summarize</button>
      <button class="btn" data-open="${esc(m.link)}">${icon('computer')} Open on computer</button>
      <a class="btn" href="${safeHref(m.link)}" target="_blank" rel="noopener">${icon('open')} Open here</a>
    </div>`);
}

// Shared actions anywhere on the page
document.addEventListener('click', e => {
  const t = e.target;
  const ask = t.closest('[data-ask]'); if (ask) { closeSheet(); unlockAudio(); return send(ask.dataset.ask); }
  const open = t.closest('[data-open]'); if (open) { closeSheet(); return action('open_on_computer', { url: open.dataset.open }, 'Opened on the computer'); }
  const go = t.closest('[data-goto]'); if (go) return switchView(go.dataset.goto);
});
$('#view-now').addEventListener('click', async e => {
  const t = e.target;
  const seg = t.closest('[data-seg]'); if (seg) { inboxTab = seg.dataset.seg; return renderNow(); }
  const mail = t.closest('[data-mail]'); if (mail) return itemSheet('mail', state.snapshot.inbox.gmail.latest[mail.dataset.mail]);
  const chat = t.closest('[data-chat]'); if (chat) return itemSheet('chat', state.snapshot.inbox.slack.mentions[chat.dataset.chat]);
  if (t.closest('[data-brief-refresh]')) return loadBrief(true);
  const bi = t.closest('[data-brief]');
  if (bi) {
    const it = briefData.items[bi.dataset.brief];
    if (it.action.ask) { unlockAudio(); return send(it.action.ask); }
    return openSheet(`<h3>${esc(it.text)}</h3><div class="body">${esc(it.why)}</div><div class="sheet-actions"><button class="btn glow" data-open="${esc(it.action.url)}">${icon('computer')} Open on computer</button><a class="btn" href="${safeHref(it.action.url)}" target="_blank" rel="noopener">${icon('open')} Open here</a></div>`);
  }
  const act = t.closest('[data-action]'); if (act) return action(act.dataset.action, {}, 'Done');
  if (t.closest('[data-notify]')) return openSheet(`<h3>Message to the screen</h3><form class="inline-form" id="notify-form"><input id="notify-input" placeholder="e.g. Back in 10 minutes"><button class="btn glow sm">Send</button></form>`);
  const note = t.closest('[data-note]');
  if (note) {
    const id = note.dataset.note;
    if (t.closest('.check')) await api(`/api/notes/${id}`, { method: 'POST', body: { done: !note.classList.contains('done') } });
    else if (t.closest('[data-del]')) await api(`/api/notes/${id}`, { method: 'DELETE' });
    else return;
    refresh(true);
  }
});
document.addEventListener('submit', async e => {
  if (e.target.id === 'note-form') {
    e.preventDefault(); const text = $('#note-input').value.trim(); if (!text) return;
    await api('/api/notes', { method: 'POST', body: { text } }); $('#note-input').blur(); refresh(true);
  }
  if (e.target.id === 'notify-form') {
    e.preventDefault(); const msg = $('#notify-input').value.trim(); if (!msg) return;
    closeSheet(); action('notify_computer', { message: msg }, 'Shown on the screen');
  }
});
async function action(tool, input, ok) {
  try { const r = await api('/api/action', { method: 'POST', body: { tool, input } }); toast(r?.note || ok); }
  catch (err) { toast(err.message); }
}

/* ============================== SCREEN ============================== */
$('#shot-btn').addEventListener('click', async () => {
  const btn = $('#shot-btn'); btn.disabled = true; $('#scan').hidden = false;
  try {
    const r = await api('/api/action', { method: 'POST', body: { tool: 'view_screen' } });
    $('#shot').src = `data:${r.mediaType};base64,${r.image}`; $('#shot').hidden = false; $('#shot-actions').hidden = false;
    $('#shot-note').textContent = r.note || '';
  } catch (err) { $('#shot-note').textContent = err.message; }
  btn.disabled = false; $('#scan').hidden = true;
});

/* ============================== SYSTEM ============================== */
function renderSystem() {
  const s = state.settings;
  const voices = s.voices[(s.voiceEngine === 'auto' ? s.activeVoice : s.voiceEngine)] || [];
  $('#view-system').innerHTML = `
    <div class="panel edge" id="connections"><div class="panel-head"><span class="label">Connections</span><button class="icon-btn" id="conn-refresh" aria-label="Check again">${I.refresh}</button></div><div class="shimmer"></div><div class="shimmer" style="width:70%"></div></div>

    <div class="panel" id="sec-network">${networkPanel()}</div>

    <div class="panel" id="sec-test"><div class="panel-head"><span class="label">AI check</span><button class="btn glow sm" id="test-ai">${icon('spark', 13)} Test AI</button></div>
      <p class="dim" style="font-size:13px;margin:0">Sends a tiny real request to the assistant, the voice and the listening service, and shows speed and exactly what was sent.</p>
      <div id="test-results"></div></div>

    <div class="panel" id="sec-computers"><div class="panel-head"><span class="label">Computers</span></div>
      ${state.devices.map(d => `<div class="kv" style="align-items:center"><span style="text-transform:none;letter-spacing:0;font:inherit;color:var(--text);display:flex;gap:8px;align-items:center"><span class="dot ${d.online ? 'on' : ''}"></span>${esc(d.name)} <span class="mono dim" style="font-size:11px">${esc(PLAT[d.platform] || d.platform)}${d.selected ? ' · ACTIVE' : ''}</span></span>
        <span>${d.selected ? '' : `<button class="btn sm" data-dev="${esc(d.id)}" data-op="select">Use</button>`} <button class="btn sm danger" data-dev="${esc(d.id)}" data-op="revoke">Remove</button></span></div>`).join('') || '<div class="empty">No computers yet.</div>'}
      <form class="inline-form" id="pair-form"><input id="pair-code" placeholder="Pairing code  K7Q-42M" autocapitalize="characters" autocomplete="off"><button class="btn glow sm">Pair</button></form>
      <p class="dim" style="font-size:13px">What Aura may do on a computer is set on that computer (http://127.0.0.1:8101).</p></div>

    <div class="panel" id="sec-voice"><div class="panel-head"><span class="label">Voice</span><button class="btn sm" id="test-voice">▶ Test voice</button></div>
      <div class="field"><label for="set-vengine">Engine</label><select id="set-vengine">${[['auto', 'Auto — most natural available'], ['elevenlabs', 'ElevenLabs — most human'], ['openai', 'OpenAI — natural'], ['browser', 'Phone voice — basic']].map(([v, l]) => `<option value="${v}" ${v === s.voiceEngine ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="set-voice">Voice</label><select id="set-voice">${voices.length ? voices.map(v => `<option value="${esc(v.id)}" ${v.id === s.voice ? 'selected' : ''}>${esc(v.name)}</option>`).join('') : '<option value="">Phone default</option>'}</select></div>
      <div class="field" data-keyfor="openai"><label for="set-openai-voice">OpenAI API key ${s.providers.openai.hasKey ? '· saved' : ''}</label><input id="set-openai-voice" type="password" autocomplete="off" placeholder="${s.providers.openai.hasKey ? '•••••••• (leave empty to keep)' : 'paste key from platform.openai.com'}"></div>
      <div class="field" data-keyfor="elevenlabs"><label for="set-eleven">ElevenLabs API key ${s.hasElevenKey ? '· saved' : ''}</label><input id="set-eleven" type="password" autocomplete="off" placeholder="${s.hasElevenKey ? '•••••••• (leave empty to keep)' : 'paste key from elevenlabs.io'}"></div>
      <p class="dim" style="font-size:13px">Listening with: <b style="color:var(--text)">${s.stt === 'openai' ? 'OpenAI transcription' : 'the browser\'s speech recognition'}</b>. Speaking with: <b style="color:var(--text)">${esc({ elevenlabs: 'ElevenLabs', openai: 'OpenAI', browser: 'the phone\'s built-in voice' }[s.activeVoice])}</b>. ${s.voiceEngine !== 'browser' && s.activeVoice === 'browser' ? '<span style="color:var(--amber)">No voice key saved yet, so the phone voice is used.</span>' : ''}</p>
      <div class="row-actions"><button class="btn glow sm" data-save>Save</button></div></div>

    <div class="panel" id="sec-assistant"><div class="panel-head"><span class="label">Assistant</span></div>
      <div class="field"><label for="set-provider">AI provider</label><select id="set-provider">${Object.entries(s.providers).map(([id, p]) => `<option value="${esc(id)}" ${id === s.provider ? 'selected' : ''}>${esc(p.label)}${p.ready ? '' : ' — needs key'}</option>`).join('')}</select></div>
      <div class="field"><label for="set-model">Model</label><input id="set-model" list="model-list" value="${esc(s.model)}" autocomplete="off"><datalist id="model-list"></datalist></div>
      <div class="field" id="key-field"></div>
      <div class="field" id="base-field"></div>
      <div class="field"><label for="set-effort">Effort — lower answers faster</label><select id="set-effort">${['low', 'medium', 'high'].map(m => `<option ${m === s.effort ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div class="row-actions"><button class="btn glow sm" data-save>Save</button><button class="btn sm" id="test-provider">Test this model</button></div>
      <div id="test-provider-results"></div>
      <p class="dim" style="font-size:13px">Keys stay on the hub and are never sent back to this page.</p></div>

    <div class="panel"><div class="panel-head"><span class="label">Activity</span><button class="btn sm" id="load-audit">Show</button></div><div id="audit"></div></div>
    <div class="row-actions" style="justify-content:center"><button class="btn danger sm" id="logout">Sign out</button></div>`;
  providerFields(true);
  voiceKeyFields();
  loadConnections();
}

async function reconnectAll(btn) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = 'Reconnecting…';
  try { const r = await api('/api/action', { method: 'POST', body: { tool: 'reconnect' } }); toast(r.note || 'Reconnected'); }
  catch (e) { toast(e.message); }
  setTimeout(async () => { try { await api('/api/action', { method: 'POST', body: { tool: 'get_overview' } }); } catch {} loadConnections(); btn.disabled = false; btn.textContent = label; }, 2500);
}

/* ---------- Other devices (local network) ---------- */
function networkPanel() {
  const n = state.network || {};
  const toggle = `<button class="chip toggle" id="net-toggle" aria-pressed="${!!n.on}" ${n.canChange ? '' : 'disabled'}><span class="led"></span>${n.on ? 'On' : 'Off'}</button>`;
  const row = (u, big) => `<div class="url-row"><code class="${big ? 'big-url' : 'dim'}">${esc(u)}</code><button class="btn sm" data-copy="${esc(u)}">Copy</button></div>`;
  if (!n.on) return `<div class="panel-head"><span class="label">Other devices</span>${toggle}</div>
    <p class="dim" style="font-size:13px;margin:0">${n.error ? `<span class="error">${esc(n.error)}</span><br>` : ''}Let phones and other computers on your Wi-Fi open Aura. They still need your PIN.${n.canChange ? '' : '<br><b>Turn this on from the computer that runs Aura.</b>'}</p>`;
  return `<div class="panel-head"><span class="label">Other devices</span>${toggle}</div>
    ${n.secureUrls?.length ? `<p style="margin:0 0 4px"><b>With talking</b> (recommended), open on a phone on the same Wi-Fi:</p>${row(n.secureUrls[0], true)}
      <p class="dim" style="font-size:13px;margin:4px 0 12px">The first time, the phone says the connection isn't private, because the certificate comes from your own computer. iPhone: <b>Show Details → visit this website</b>. Android: <b>Advanced → Proceed</b>. After that the microphone works.</p>` : ''}
    ${n.urls?.length ? `<p style="margin:0 0 4px">Without talking (no warning):</p>${row(n.urls[0], !n.secureUrls?.length)}` : ''}
    ${n.error ? `<p class="error" style="font-size:13px">${esc(n.error)}</p>` : ''}
    <details class="sent"><summary class="mono">Other addresses</summary>${[...(n.secureUrls || []).slice(1), ...(n.urls || []).slice(1)].map(u => row(u)).join('') || '<p class="dim">None.</p>'}</details>`;
}
$('#view-system').addEventListener('click', async e => {
  const c = e.target.closest('[data-copy]');
  if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Copied'); } catch { toast(c.dataset.copy); } return; }
  const t = e.target.closest('#net-toggle'); if (!t || t.disabled) return;
  t.disabled = true;
  try { state.network = { ...(await api('/api/network', { method: 'POST', body: { on: t.getAttribute('aria-pressed') !== 'true' } })) }; }
  catch (err) { toast(err.message); }
  $('#sec-network').innerHTML = networkPanel();
  loadConnections();
});

/* ---------- AI check ---------- */
function renderTest(el, r) {
  const fmt = ms => ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms + ' ms';
  el.innerHTML = r.results.map(x => `<div class="conn ${x.ok ? 'ok' : 'error'}"><span class="cdot"></span><div class="cmain"><div class="cname">${esc(x.part)} <span class="mono dim" style="font-size:11px;font-weight:400">${esc(x.target)}</span></div><div class="cdet">${esc(x.ok ? x.detail : x.error)}</div></div><span class="cstat mono">${x.ok ? (x.firstTokenMs ? `1st word ${fmt(x.firstTokenMs)}<br>` : '') + fmt(x.ms) : 'failed'}</span></div>`).join('')
    + (Object.keys(r.headers).length ? `<details class="sent"><summary class="mono">What was sent (no browser headers)</summary>${Object.entries(r.headers).map(([host, h]) => `<pre>${esc(`${h.method} https://${host}${h.path}\n` + Object.entries(h.headers).map(([k, v]) => `${k}: ${v}`).join('\n'))}</pre>`).join('')}</details>` : '');
}
async function runTest(btn, el, body) {
  btn.disabled = true; const label = btn.innerHTML; btn.textContent = 'Testing…';
  el.innerHTML = '<div class="shimmer"></div><div class="shimmer" style="width:60%"></div>';
  try { renderTest(el, await api('/api/test-ai', { method: 'POST', body })); }
  catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
  btn.disabled = false; btn.innerHTML = label;
}
$('#view-system').addEventListener('click', e => {
  if (e.target.closest('#test-ai')) runTest(e.target.closest('#test-ai'), $('#test-results'), {});
  if (e.target.closest('#test-provider')) runTest(e.target.closest('#test-provider'), $('#test-provider-results'), { provider: $('#set-provider').value, model: $('#set-model').value.trim(), parts: ['chat'] });
});

/* ---------- Connections: what's linked, what isn't, and how to fix it ---------- */
let connData = null;
const CONN_LABEL = { ok: 'Connected', warn: 'Needs attention', error: 'Not working', off: 'Off', idle: 'Not open' };
async function loadConnections() {
  try { connData = await api('/api/connections'); } catch (e) { connData = { error: e.message }; }
  renderConnections();
}
function renderConnections() {
  const el = $('#connections'); if (!el) return;
  if (connData?.error) { el.innerHTML = `<div class="label">Connections</div><p class="dim">${esc(connData.error)}</p>`; return; }
  const items = connData.items, c = connData.counts;
  const bad = (c.error || 0) + (c.warn || 0);
  const groups = [...new Set(items.map(i => i.group))];
  el.innerHTML = `<div class="panel-head"><span class="label">Connections</span><span style="display:flex;gap:6px;align-items:center"><button class="btn sm" id="reconnect-all">↻ Reconnect all</button><button class="btn sm" data-jump="sec-test">Test AI</button><button class="icon-btn" id="conn-refresh" aria-label="Check again">${I.refresh}</button></span></div>
    <h2 style="margin:0 0 4px;font-size:19px">${bad ? `${bad} thing${bad > 1 ? 's' : ''} need${bad > 1 ? '' : 's'} fixing` : 'Everything is connected'}</h2>
    <div class="conn-sum mono">${['ok', 'warn', 'error', 'off'].filter(k => c[k]).map(k => `<span class="pill ${k}">${c[k]} ${CONN_LABEL[k].toLowerCase()}</span>`).join('')}</div>
    ${groups.map(g => `<div class="conn-group">${esc(g)}</div>` + items.filter(i => i.group === g).map((it, n) => {
      const idx = items.indexOf(it);
      return `<div class="conn ${esc(it.status)}" data-conn="${idx}"><span class="cdot"></span><div class="cmain"><div class="cname">${esc(it.name)}</div><div class="cdet">${esc(it.detail)}</div></div>${it.fix ? `<button class="btn sm ${it.status === 'error' ? 'glow' : ''}" data-fix="${idx}">${esc(it.fix.label || 'How to fix')}</button>` : `<span class="cstat">${esc(CONN_LABEL[it.status])}</span>`}</div>`;
    }).join('')).join('')}`;
}
$('#view-system').addEventListener('click', async e => {
  if (e.target.closest('#conn-refresh')) {
    toast('Checking…');
    try { await api('/api/action', { method: 'POST', body: { tool: 'get_overview' } }); } catch {}
    return setTimeout(loadConnections, 600);
  }
  const j = e.target.closest('[data-jump]'); if (j) return document.getElementById(j.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (e.target.closest('#reconnect-all')) return reconnectAll(e.target.closest('#reconnect-all'));
  const f = e.target.closest('[data-fix]'); if (!f) return;
  const it = connData.items[f.dataset.fix], fix = it.fix;
  if (fix.type === 'reconnect') return reconnectAll(f);
  if (fix.type === 'open') { await action('open_on_computer', { url: fix.url }, `Opened on the computer: sign in there, then check again`); return setTimeout(loadConnections, 4000); }
  if (fix.type === 'goto') { document.getElementById('sec-' + fix.section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  openSheet(`<h3>${esc(it.name)}</h3><div class="body">${esc(it.detail)}</div><div class="panel" style="margin:0"><div class="label" style="margin-bottom:6px">How to fix</div><div style="white-space:pre-wrap">${esc(fix.how)}</div></div><div class="sheet-actions" style="margin-top:12px"><button class="btn glow" id="conn-recheck">I did it, check again</button></div>`);
});
document.addEventListener('click', e => { if (e.target.id === 'conn-recheck') { closeSheet(); switchView('system'); setTimeout(() => document.querySelector('#conn-refresh')?.click(), 50); } });
// Show only the key field for the voice engine that's selected.
function voiceKeyFields() {
  const eng = $('#set-vengine').value;
  document.querySelectorAll('[data-keyfor]').forEach(f => { f.hidden = !(eng === f.dataset.keyfor || eng === 'auto'); });
}
function providerFields(keepModel) {
  const s = state.settings, id = $('#set-provider').value, p = s.providers[id];
  $('#key-field').innerHTML = p.local ? '' : `<label for="set-key">${esc(p.label)} key ${p.hasKey ? '· saved' : ''}</label><input id="set-key" type="password" autocomplete="off" placeholder="${p.hasKey ? '•••••••• (leave empty to keep)' : 'paste key'}">`;
  $('#base-field').innerHTML = p.local || ['lambda', 'openai'].includes(id) ? `<label for="set-base">Endpoint</label><input id="set-base" value="${esc(p.base)}" autocomplete="off">` : '';
  if (!keepModel) $('#set-model').value = p.models[0] || '';
  $('#model-list').innerHTML = p.models.map(m => `<option value="${esc(m)}">`).join('');
  api('/api/models?provider=' + encodeURIComponent(id)).then(list => { if ($('#set-provider')?.value === id) $('#model-list').innerHTML = list.map(m => `<option value="${esc(m)}">`).join(''); }).catch(() => {});
}
$('#view-system').addEventListener('change', e => {
  if (e.target.id === 'set-provider') providerFields(false);
  if (e.target.id === 'set-vengine') {
    voiceKeyFields();
    const s = state.settings, eng = e.target.value === 'auto' ? s.activeVoice : e.target.value, vs = s.voices[eng] || [];
    $('#set-voice').innerHTML = vs.length ? vs.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('') : '<option value="">Phone default</option>';
  }
});
async function saveSettings() {
  const provider = $('#set-provider').value;
  const body = { provider, model: $('#set-model').value.trim(), effort: $('#set-effort').value, voiceEngine: $('#set-vengine').value, voice: $('#set-voice').value };
  const keys = {};
  if ($('#set-key')?.value.trim()) keys[provider] = $('#set-key').value.trim();
  if ($('#set-eleven').value.trim()) keys.elevenlabs = $('#set-eleven').value.trim();
  if ($('#set-openai-voice').value.trim()) keys.openai = $('#set-openai-voice').value.trim();
  if (Object.keys(keys).length) body.keys = keys;
  if ($('#set-base')) body.baseUrls = { [provider]: $('#set-base').value.trim() };
  await api('/api/settings', { method: 'POST', body });
  await refresh();
}
$('#view-system').addEventListener('click', async e => {
  const t = e.target;
  const dev = t.closest('[data-dev]');
  if (dev) {
    if (dev.dataset.op === 'revoke' && !confirm('Remove this computer? Its agent will need to pair again.')) return;
    try { await api(`/api/devices/${dev.dataset.dev}/${dev.dataset.op}`, { method: 'POST' }); } catch (err) { toast(err.message); }
    return refresh();
  }
  if (t.closest('[data-save]')) { try { await saveSettings(); toast('Saved'); } catch (err) { toast(err.message); } }
  if (t.id === 'test-voice') {
    unlockAudio();
    try { await saveSettings(); } catch {}
    speaker.stop(); speaker.say('Hi, I\'m Aura. Your next meeting starts soon, and a couple of people are waiting on you. Want me to walk you through it?');
  }
  if (t.id === 'load-audit') {
    const rows = await api('/api/audit');
    $('#audit').innerHTML = rows.slice(0, 40).map(r => `<div class="kv"><span>${esc(short(Date.parse(r.at)))}</span><span>${esc(r.event)}${r.tool ? ' · ' + esc(r.tool) : ''}${r.via ? ' (' + esc(r.via) + ')' : ''}</span></div>`).join('') || '<div class="empty">Nothing yet.</div>';
  }
  if (t.id === 'logout') { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.reload(); }
});
$('#view-system').addEventListener('submit', async e => {
  if (e.target.id !== 'pair-form') return;
  e.preventDefault();
  try { const d = await api('/api/devices/pair', { method: 'POST', body: { code: $('#pair-code').value } }); toast(`Paired ${d.name}`); refresh(); }
  catch (err) { toast(err.message); }
});

/* ============================== TALK ============================== */
function bubble(role, text, cls = '') {
  const el = document.createElement('div'); el.className = `bubble ${role} ${cls}`; el.textContent = text;
  $('#chat').append(el); el.scrollIntoView({ block: 'end', behavior: 'smooth' }); return el;
}
const STEP = { get_overview: 'Checking your computer', view_screen: 'Looking at the screen', open_on_computer: 'Opening on the computer', draft_email: 'Opening a draft', notify_computer: 'Showing a notification', lock_computer: 'Locking the screen', slack_send: 'Sending on Slack', run_command: 'Running a command', browser_tabs: 'Scanning browser tabs', browser_read: 'Reading a web app', browser_act: 'Acting in a web app', add_note: 'Adding a note', complete_note: 'Updating notes' };
let suggestions = [];
function renderSuggestions() {
  const fromBrief = (briefData?.items || []).filter(i => i.action.ask).slice(0, 3).map(i => i.action.ask);
  suggestions = [...new Set([...fromBrief, 'Brief me on today', 'Anything urgent?', "What's on my screen?", 'Prep me for my next meeting'])].slice(0, 6);
  $('#suggestions').innerHTML = suggestions.map((t, i) => `<button class="chip" data-sugg="${i}">${esc(t.length > 58 ? t.slice(0, 55) + '…' : t)}</button>`).join('');
}
$('#suggestions').addEventListener('click', e => { const b = e.target.closest('[data-sugg]'); if (b) { unlockAudio(); send(suggestions[b.dataset.sugg]); } });
async function loadHistory() {
  try {
    const h = await api('/api/chat/history');
    $('#chat').innerHTML = ''; h.forEach(m => bubble(m.role, m.text));
    $('#suggestions').hidden = h.length > 0;
  } catch {}
}

let sending = false;
async function send(text, { voice = false } = {}) {
  text = String(text || '').trim();
  if (!text || sending) return;
  sending = true; $('#suggestions').hidden = true;
  speaker.stop();
  if (view !== 'talk') switchView('talk');
  bubble('user', text);
  $('#stage-live').textContent = '';
  setOrb('thinking');
  const speakIt = voiceOn && (voice || handsFree);
  const splitter = sentenceSplitter(s => { if (speakIt) speaker.say(s); });
  let cur = null, lastStep = null, full = '';
  const ensure = () => (cur ||= bubble('assistant', '', 'typing'));
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, tz }) });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') {
          ensure(); cur.textContent += ev.delta; full += ev.delta; splitter.push(ev.delta);
          $('#stage-live').textContent = full.length > 160 ? '…' + full.slice(-160) : full;
          cur.scrollIntoView({ block: 'end' });
        } else if (ev.type === 'tool') {
          if (cur) { cur.classList.remove('typing'); if (!cur.textContent) cur.remove(); }
          cur = null; full = ''; splitter.flush();
          lastStep = document.createElement('div'); lastStep.className = 'step';
          lastStep.innerHTML = `<span class="spin"></span>${esc(STEP[ev.name] || ev.name)}`;
          lastStep.dataset.label = STEP[ev.name] || ev.name;
          $('#chat').append(lastStep); lastStep.scrollIntoView({ block: 'end' });
          if (!speaker.playing) setOrb('thinking');
        } else if (ev.type === 'tool_done') {
          if (lastStep) { lastStep.className = 'step ' + (ev.ok ? 'ok' : 'fail'); lastStep.textContent = (ev.ok ? '✓ ' : '✕ ') + lastStep.dataset.label + (ev.ok ? '' : ` — ${ev.error}`); }
        } else if (ev.type === 'approval') {
          await refresh(true); window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (ev.type === 'error') bubble('assistant', ev.error, 'error');
      }
    }
  } catch (err) { bubble('assistant', err.message, 'error'); }
  finally {
    if (cur) { cur.classList.remove('typing'); if (!cur.textContent) cur.remove(); }
    splitter.flush();
    sending = false;
    if (!speaker.playing && orb.state !== 'listening') { setOrb('idle'); setTimeout(() => { if (!speaker.playing && !sending && !listening) $('#stage-live').textContent = ''; }, 2500); afterSpeaking(); }
    refresh(true);
  }
}
$('#composer').addEventListener('submit', e => { e.preventDefault(); unlockAudio(); const v = $('#ask-input').value; $('#ask-input').value = ''; send(v); });
$('#new-chat').addEventListener('click', async () => { speaker.stop(); await api('/api/chat/reset', { method: 'POST' }); $('#chat').innerHTML = ''; $('#stage-live').textContent = ''; $('#suggestions').hidden = false; renderSuggestions(); });
$('#speak-toggle').addEventListener('click', () => { voiceOn = !voiceOn; if (!voiceOn) speaker.stop(); $('#speak-toggle').setAttribute('aria-pressed', voiceOn); api('/api/settings', { method: 'POST', body: { voiceReplies: voiceOn } }).catch(() => {}); });
$('#hands-free').addEventListener('click', () => {
  handsFree = !handsFree; $('#hands-free').setAttribute('aria-pressed', handsFree);
  api('/api/settings', { method: 'POST', body: { handsFree } }).catch(() => {});
  toast(handsFree ? 'Hands-free on: Aura listens again after each reply' : 'Hands-free off');
  setOrb(orb.state);
  if (handsFree && !listening && !sending) startListening();
});
$('#orb-btn').addEventListener('click', orbTap);
$('#stage-orb').addEventListener('click', orbTap);

/* ============================== navigation ============================== */
function switchView(v) {
  view = v;
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== `view-${v}`);
  document.querySelectorAll('.dock [data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#composer').hidden = v !== 'talk';
  if (v === 'now') renderNow();
  if (v === 'system') renderSystem();
  if (v === 'talk') { renderSuggestions(); setTimeout(() => $('#chat').lastElementChild?.scrollIntoView({ block: 'end' }), 60); }
  window.scrollTo({ top: 0 });
}
document.querySelector('.dock').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) switchView(b.dataset.view); });
$('#sys-pill').addEventListener('click', async () => {
  toast('Refreshing…');
  try { await api('/api/action', { method: 'POST', body: { tool: 'get_overview' } }); } catch (err) { toast(err.message); }
  setTimeout(() => refresh(true), 400);
});

boot();
