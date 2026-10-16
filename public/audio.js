'use strict';

// 声音：背景音乐 + 胜利 / 失败 / 轮到你 的音效
// 默认全部用 Web Audio 实时合成，旋律是原创的，没有版权问题。
// 想换成自己的音频（必须是你有权使用的），把 bgm.mp3 / win.mp3 / lose.mp3 放进 public/audio/，会自动优先使用。
const Sound = (() => {
  const PREF_KEY = 'poker.audio';
  const prefs = { music: true, sfx: true, musicVol: 0.5, sfxVol: 0.8, ...loadPrefs() };
  const files = { bgm: null, win: null, lose: null }; // 有自定义文件时是 <audio> 元素
  let ctx = null;
  let musicBus = null;
  let sfxBus = null;
  let noiseBuf = null;
  let wantMusic = false; // 牌局是否在进行（由 app.js 每次渲染时告诉我们）
  let timer = null;
  let nextTime = 0;
  let step = 0;

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; }
  }
  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 忽略 */ }
  }

  // 浏览器规定：用户点过页面之后才能出声，所以在第一次点击/按键时才初始化
  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      musicBus = ctx.createGain();
      musicBus.connect(master);
      sfxBus = ctx.createGain();
      sfxBus.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      applyVolumes();
    }
    if (ctx.state === 'suspended') ctx.resume();
    sync();
  }
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(ev, unlock, { passive: true });
  document.addEventListener('visibilitychange', () => sync());

  // 服务器告诉我们有哪些自定义音频文件
  fetch('/api/info').then((r) => r.json()).then((info) => {
    for (const name of info.audio || []) {
      if (!(name in files)) continue;
      const a = new Audio(`audio/${name}.mp3`);
      a.preload = 'auto';
      a.loop = name === 'bgm';
      files[name] = a;
    }
    applyVolumes();
    sync();
  }).catch(() => {});

  function applyVolumes() {
    if (musicBus) musicBus.gain.value = prefs.musicVol * 0.35;
    if (sfxBus) sfxBus.gain.value = prefs.sfxVol * 0.6;
    if (files.bgm) files.bgm.volume = Math.min(1, prefs.musicVol * 0.6);
    for (const k of ['win', 'lose']) if (files[k]) files[k].volume = prefs.sfxVol;
  }

  // 该不该放音乐：牌局在进行 + 音乐开关打开 + 页面在前台
  function sync() {
    const on = wantMusic && prefs.music && !document.hidden;
    if (files.bgm) {
      stopSynth();
      if (on) files.bgm.play().catch(() => {});
      else files.bgm.pause();
      return;
    }
    if (on && ctx && ctx.state === 'running') startSynth();
    else stopSynth();
  }

  // ---------- 合成器 ----------
  const midi = (n) => 440 * 2 ** ((n - 69) / 12);

  function tone(note, t, dur, type, vol, bus, cutoff) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = midi(note);
    let out = osc;
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoff;
      osc.connect(f);
      out = f;
    }
    out.connect(g);
    g.connect(bus);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(vol * 0.45, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(t, dur, vol, filterType, freq, bus) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    const g = ctx.createGain();
    src.connect(f);
    f.connect(g);
    g.connect(bus);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  function kick(t) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.7, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g);
    g.connect(musicBus);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  // ---------- 背景音乐：原创的轻快小调，C 大调五声音阶，8 小节循环 ----------
  const BPM = 128;
  const EIGHTH = 60 / BPM / 2;
  const _ = 0; // 休止
  const MELODY = [
    76, 76, 79, 81, 79, _, 76, 74,
    72, 74, 76, 79, 76, _, _, _,
    81, 81, 79, 76, 79, 81, 84, _,
    81, 79, 76, 74, 76, _, _, _,
    74, 76, 74, 72, 69, 72, 74, _,
    76, 79, 76, 74, 72, _, 69, _,
    67, 69, 72, 74, 76, 79, 81, 79,
    76, 74, 76, _, 72, _, _, _,
  ];
  const BARS = ['C', 'C', 'F', 'C', 'Dm', 'Am', 'G', 'C'];
  const CHORD = { C: [60, 64, 67], F: [60, 65, 69], G: [59, 62, 67], Am: [57, 60, 64], Dm: [57, 62, 65] };
  const ROOT = { C: 36, F: 41, G: 43, Am: 45, Dm: 38 };

  function playStep(i, t) {
    const pos = i % 8;
    const chord = BARS[Math.floor(i / 8)];
    if (MELODY[i]) tone(MELODY[i], t, EIGHTH * 0.92, 'square', 0.2, musicBus, 2600);
    if (pos % 2 === 0) tone(ROOT[chord] + (pos === 2 || pos === 6 ? 7 : 0), t, EIGHTH * 0.95, 'triangle', 0.55, musicBus);
    else for (const n of CHORD[chord]) tone(n, t, 0.08, 'square', 0.05, musicBus, 1800); // 反拍"嚓"
    if (pos === 0 || pos === 4) kick(t);
    if (pos === 2 || pos === 6) noise(t, 0.12, 0.28, 'bandpass', 1800, musicBus); // 军鼓
    noise(t, 0.03, pos % 2 ? 0.05 : 0.09, 'highpass', 7000, musicBus); // 踩镲
  }

  function schedule() {
    // 页面在后台被降速后回来，别把错过的音符一股脑补播
    if (nextTime < ctx.currentTime - 0.05) nextTime = ctx.currentTime + 0.05;
    while (nextTime < ctx.currentTime + 0.15) {
      playStep(step, nextTime);
      nextTime += EIGHTH;
      step = (step + 1) % MELODY.length;
    }
  }

  function startSynth() {
    if (timer) return;
    step = 0;
    nextTime = ctx.currentTime + 0.1;
    timer = setInterval(schedule, 25);
  }

  function stopSynth() {
    clearInterval(timer);
    timer = null;
  }

  // ---------- 音效 ----------
  function ready() {
    if (!prefs.sfx) return false;
    if (!ctx) unlock();
    return ctx && ctx.state === 'running';
  }

  function playFile(name) {
    const a = files[name];
    if (!a) return false;
    a.currentTime = 0;
    a.play().catch(() => {});
    return true;
  }

  // 胜利：上行琶音 + 和弦 + 一串高音闪光
  function win() {
    if (!prefs.sfx || playFile('win') || !ready()) return;
    const t = ctx.currentTime + 0.02;
    [72, 76, 79, 84].forEach((n, i) => {
      tone(n, t + i * 0.09, 0.18, 'square', 0.3, sfxBus, 4000);
      tone(n + 12, t + i * 0.09, 0.18, 'triangle', 0.15, sfxBus);
    });
    for (const n of [72, 76, 79, 84, 88]) tone(n, t + 0.38, 0.8, 'triangle', 0.22, sfxBus);
    [96, 100, 103, 108].forEach((n, i) => tone(n, t + 0.45 + i * 0.06, 0.25, 'sine', 0.12, sfxBus));
  }

  // 失败：长号式的"哇——哇——哇——哇……"，一路往下滑
  function lose() {
    if (!prefs.sfx || playFile('lose') || !ready()) return;
    const t0 = ctx.currentTime + 0.02;
    [67, 66, 65, 64].forEach((n, i) => {
      const last = i === 3;
      const t = t0 + i * 0.4;
      const dur = last ? 1.1 : 0.36;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = midi(n);
      if (last) {
        // 最后一声加颤音
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 6;
        depth.gain.value = 6;
        lfo.connect(depth);
        depth.connect(osc.frequency);
        lfo.start(t);
        lfo.stop(t + dur);
      }
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(450, t);
      f.frequency.linearRampToValueAtTime(1400, t + 0.12); // "哇"的张嘴
      f.frequency.linearRampToValueAtTime(500, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.3, t + 0.04);
      g.gain.setValueAtTime(0.3, t + dur - 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(f);
      f.connect(g);
      g.connect(sfxBus);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    });
  }

  // 轮到你：叮咚两声
  function turn() {
    if (!ready()) return;
    const t = ctx.currentTime + 0.01;
    tone(81, t, 0.18, 'sine', 0.35, sfxBus);
    tone(88, t + 0.12, 0.3, 'sine', 0.3, sfxBus);
  }

  return {
    prefs,
    hasFile: (name) => !!files[name],
    setPlaying(on) {
      if (on === wantMusic) return;
      wantMusic = on;
      sync();
    },
    set(key, value) {
      prefs[key] = value;
      savePrefs();
      applyVolumes();
      sync();
    },
    isMusicPlaying: () => !!timer || (files.bgm ? !files.bgm.paused : false),
    win,
    lose,
    turn,
  };
})();
