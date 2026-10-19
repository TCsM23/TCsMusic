(function () {
  "use strict";

  const K = window.PianoKit;
  const Hub = window.MidiHub;
  const $ = (id) => document.getElementById(id);

  const grid = $("studio-grid");
  if (!grid || !K) return;

  const STEPS = 16;             // sixteenth notes in one bar
  const LOOKAHEAD_MS = 25;      // how often the scheduler wakes up
  const SCHEDULE_AHEAD = 0.1;   // how far ahead (seconds) it plans sounds
  const STORE_KEY = "tcsmusic-studio";
  const MAP_KEY = "tcsmusic-studio-midi";
  // The drum voices (kick, snare...). Each has its own mixer channel and its own row in the sequencer.
  const TRACKS = JSON.parse($("studio-tracks-data").textContent);
  const TRACK_IDS = TRACKS.map((t) => t.id);
  const NAME = {};
  TRACKS.forEach((t) => { NAME[t.id] = t.name; });
  const SCALE_DATA = (function () {
    try { return JSON.parse($("studio-scales-data").textContent); } catch (error) { return []; }
  })();

  const playButton = $("studio-play");
  const stopButton = $("studio-stop");
  const recordButton = $("studio-record");
  const bpmInput = $("studio-bpm");
  const bpmValue = $("studio-bpm-value");
  const barsSelect = $("studio-bars");
  const presetSelect = $("studio-preset");
  const clearButton = $("studio-clear");
  const exportButton = $("studio-export");
  const exportNote = $("studio-export-note");

  // ---------- what a track can be ----------
  // inst: a virtual instrument. bass, guitar: the same, with a bass or a plucked-string sound to start with.
  // sampler: your own sound, played across the keys. audio: recordings and imported clips. drums: a 16-step machine.
  const KINDS = {
    drums:   { label: "Drum Machine", icon: "🥁", base: 48 },
    inst:    { label: "Instrument", icon: "🎹", inst: "piano", base: 48 },
    bass:    { label: "Bass", icon: "🎸", inst: "bass", base: 24 },
    guitar:  { label: "Guitar", icon: "🎸", inst: "guitar", base: 40 },
    sampler: { label: "Sampler", icon: "🎛️", base: 48 },
    audio:   { label: "Voice / Audio", icon: "🎙️", base: 48 },
  };
  const NOTE_KINDS = ["inst", "bass", "guitar", "sampler"]; // tracks with a piano roll
  const freshMix = () => ({ vol: 0.8, pan: 0, mute: false, solo: false, rev: 0, del: 0, drive: 0, tone: 1 });
  const emptyPattern = () => {
    const p = {};
    TRACK_IDS.forEach((id) => { p[id] = new Array(STEPS).fill(false); });
    return p;
  };

  // ---------- data ----------
  // pattern.kick[3] === true means "play the kick on step 4"
  const S = {
    bars: 1,
    tracks: [],     // each: { id, type, name, inst, notes, pedal, rollBase, release, sample, clips, pattern, builtin }
    active: "",     // the track you are working on
    mixer: {},      // { vol 0-1, pan -1..1, mute, solo, rev, del, drive, tone } per channel (drum voices and tracks)
    master: 0.9,
    pads: ["kick", "snare", "clap", "hat", "open", "tom", "rim", "cow",
           "kick", "snare", "clap", "hat", "open", "tom", "rim", "cow"],
    snap: 2,
    sfx: false,     // sound-effect mode: drums play once, and the export is one trimmed, level-matched take
    metro: false,
    tool: "draw",   // draw: click to add notes. select: drag a box round notes.
    scale: { root: 2, name: "Off", pcs: [], show: false }, // shaded on the roll when a scale is chosen
  };
  let nextId = 1;
  let lastDrumId = "drums";
  let lastNoteId = "";

  // each instrument gets its own colour on the roll, so layers are easy to tell apart
  const HUES = { piano: 355, epiano: 20, organ: 38, synth: 280, harpsichord: 28, musicbox: 190, cathedral: 46,
    choir: 205, strings: 255, bells: 170, harp: 140, chiplead: 100, chipbass: 75, drone: 310, sine: 225, noise: 330, gong: 60,
    bass: 95, guitar: 30, eguitar: 8, sample: 160 };

  const trackById = (id) => S.tracks.find((t) => t.id === id) || null;
  const activeTrack = () => trackById(S.active) || S.tracks[0];
  const isNoteKind = (t) => !!t && NOTE_KINDS.includes(t.type);
  const drumTrack = () => { const a = activeTrack(); return a && a.type === "drums" ? a : (trackById(lastDrumId) || S.tracks.find((t) => t.type === "drums")); };
  // the track that live keys and recorded notes go to
  const noteTrack = () => { const a = activeTrack(); return isNoteKind(a) ? a : (trackById(lastNoteId) || S.tracks.find(isNoteKind) || null); };

  // These three follow whichever track you are working on, so the sequencer and the roll
  // keep reading S.pattern, S.notes and S.rollBase.
  Object.defineProperty(S, "pattern", { get() { return drumTrack().pattern; }, set(v) { drumTrack().pattern = v; } });
  Object.defineProperty(S, "notes", {
    get() { const t = noteTrack(); return t ? t.notes : []; },
    set(v) { const t = noteTrack(); if (t) t.notes = v; },
  });
  Object.defineProperty(S, "rollBase", {
    get() { const t = noteTrack() || activeTrack(); return t ? t.rollBase : 48; },
    set(v) { const t = noteTrack() || activeTrack(); if (t) t.rollBase = v; },
  });

  function newTrack(type, name, forcedId) {
    const kind = KINDS[type];
    let id = forcedId;
    if (!id) { id = "t" + nextId; while (trackById(id)) { nextId += 1; id = "t" + nextId; } nextId += 1; }
    const same = S.tracks.filter((t) => t.type === type).length;
    const t = {
      id, type, name: name || kind.label + (same ? " " + (same + 1) : ""), inst: kind.inst || "piano",
      notes: [], pedal: [], rollBase: kind.base, release: 0, sample: null, clips: [],
      pattern: type === "drums" ? emptyPattern() : null, builtin: false,
    };
    if (!S.mixer[id]) S.mixer[id] = freshMix();
    return t;
  }

  const stepButtons = {};
  TRACK_IDS.forEach((id) => {
    stepButtons[id] = [];
    S.mixer[id] = freshMix();
  });
  {
    const drums = newTrack("drums", "Drum Machine", "drums");
    drums.builtin = true;
    S.tracks.push(drums);
    const keys = newTrack("inst", "Keys");
    S.tracks.push(keys);
    S.active = keys.id;
    lastNoteId = keys.id;
  }

  const channels = () => TRACK_IDS.concat(S.tracks.map((t) => t.id));
  const nameOf = (id) => (NAME[id] || (trackById(id) ? (id === "drums" ? "Drums" : trackById(id).name) : id));

  grid.querySelectorAll(".studio-grid-step").forEach((button) => {
    stepButtons[button.dataset.track][Number(button.dataset.step)] = button;
  });

  // "x" is a hit, "." is a rest. Easy to read and easy to type.
  const PRESETS = {
    four: { kick: "x...x...x...x...", snare: "....x.......x...", hat: "..x...x...x...x." },
    boom: { kick: "x.....x...x.....", snare: "....x.......x...", hat: "x.x.x.x.x.x.x.x.", open: "......x.......x." },
    half: { kick: "x...............", snare: "........x.......", clap: "........x.......", hat: "x.x.x.x.x.x.x.x." },
  };

  const totalSteps = () => S.bars * STEPS;
  const stepLength = () => 60 / Number(bpmInput.value) / 4; // one sixteenth note, in seconds
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------- the user's own sounds: samples and recordings are kept in this browser ----------
  const audio = { buffers: {}, peaks: {}, loading: {} };

  const idb = (function () {
    let opened = null;
    function open() {
      if (!opened) {
        opened = new Promise((resolve, reject) => {
          if (!window.indexedDB) { reject(new Error("no storage")); return; }
          const request = indexedDB.open("tcsmusic-studio-audio", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("blobs");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }
      return opened;
    }
    function run(mode, fn) {
      return open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction("blobs", mode);
        const request = fn(tx.objectStore("blobs"));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
      }));
    }
    return {
      put: (id, blob) => run("readwrite", (store) => store.put(blob, id)),
      get: (id) => run("readonly", (store) => store.get(id)),
      del: (id) => run("readwrite", (store) => store.delete(id)),
    };
  })();

  function peaksOf(buffer) {
    const n = 1200;
    const out = new Float32Array(n);
    const data = buffer.getChannelData(0);
    const size = Math.max(1, Math.floor(data.length / n));
    for (let i = 0; i < n; i++) {
      let peak = 0;
      const from = i * size;
      for (let j = from; j < Math.min(data.length, from + size); j += Math.max(1, size >> 4)) peak = Math.max(peak, Math.abs(data[j]));
      out[i] = peak;
    }
    return out;
  }

  async function decodeBlob(blob) {
    const bytes = await blob.arrayBuffer();
    return K.getCtx().decodeAudioData(bytes.slice(0));
  }

  async function storeAudio(blob) {
    const id = "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    audio.buffers[id] = await decodeBlob(blob);
    audio.peaks[id] = peaksOf(audio.buffers[id]);
    try { await idb.put(id, blob); } catch (error) { /* kept for this visit only */ }
    return id;
  }

  // Bring a saved sample or clip back from the browser's storage.
  function ensureAudio(id) {
    if (!id || audio.buffers[id] || audio.loading[id]) return;
    audio.loading[id] = idb.get(id).then(async (blob) => {
      if (!blob) return;
      audio.buffers[id] = await decodeBlob(blob);
      audio.peaks[id] = peaksOf(audio.buffers[id]);
      dirty = true;
      if (typeof renderSettings === "function") renderSettings();
    }).catch(() => { /* gone: the track just stays silent */ }).then(() => { delete audio.loading[id]; });
  }

  // ---------- sounds (all built from oscillators and noise) ----------
  const noises = new WeakMap();

  function noiseBuffer(ctx) {
    if (!noises.has(ctx)) {
      const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noises.set(ctx, buffer);
    }
    return noises.get(ctx);
  }

  function noiseHit(ctx, bus, time, o) {
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.frequency.value = o.freq;
    filter.Q.value = o.q || 0.7;
    const gain = ctx.createGain();
    const start = time + (o.offset || 0);
    gain.gain.setValueAtTime(o.peak, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + o.decay);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    source.start(start, Math.random() * 0.5);
    source.stop(start + o.decay + 0.05);
  }

  function tone(ctx, bus, time, type, from, to, sweep, peak, decay) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, time);
    osc.frequency.exponentialRampToValueAtTime(to, time + sweep);
    gain.gain.setValueAtTime(peak, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(time);
    osc.stop(time + decay + 0.05);
  }

  const VOICES = {
    kick(ctx, bus, t) { tone(ctx, bus, t, "sine", 150, 45, 0.12, 1, 0.4); },
    snare(ctx, bus, t) {
      noiseHit(ctx, bus, t, { type: "highpass", freq: 1200, peak: 0.7, decay: 0.18 });
      tone(ctx, bus, t, "triangle", 190, 120, 0.08, 0.5, 0.12);
    },
    clap(ctx, bus, t) {
      [0, 0.012, 0.024].forEach((offset) => {
        noiseHit(ctx, bus, t, { type: "bandpass", freq: 1400, q: 1, peak: 0.6, decay: 0.012, offset });
      });
      noiseHit(ctx, bus, t, { type: "bandpass", freq: 1400, q: 1, peak: 0.5, decay: 0.16, offset: 0.036 });
    },
    hat(ctx, bus, t) { noiseHit(ctx, bus, t, { type: "highpass", freq: 7000, peak: 0.35, decay: 0.05 }); },
    open(ctx, bus, t) { noiseHit(ctx, bus, t, { type: "highpass", freq: 7000, peak: 0.3, decay: 0.35 }); },
    tom(ctx, bus, t) { tone(ctx, bus, t, "sine", 190, 85, 0.18, 0.9, 0.38); },
    rim(ctx, bus, t) {
      tone(ctx, bus, t, "square", 1700, 1100, 0.01, 0.25, 0.04);
      noiseHit(ctx, bus, t, { type: "bandpass", freq: 3200, q: 2, peak: 0.35, decay: 0.03 });
    },
    cow(ctx, bus, t) {
      tone(ctx, bus, t, "square", 560, 560, 0.01, 0.22, 0.3);
      tone(ctx, bus, t, "square", 845, 845, 0.01, 0.22, 0.3);
    },
  };

  // ---------- the engine: channels -> effects -> pan -> master -> output ----------
  // The same code builds the live engine and the offline one that renders a WAV.
  const toneHz = (norm) => 250 * Math.pow(80, norm); // 250 Hz (dark) up to 20 kHz (bright)

  function impulse(ctx) {
    const seconds = 2.2;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
    }
    return buffer;
  }

  const softClip = (function () {
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / (curve.length - 1)) * 2 - 1);
    return curve;
  })();

  // One mixer channel: tone -> (dry + drive) -> pan -> output, with reverb and echo sends taken after the pan.
  function makeChannel(e, id) {
    const ctx = e.ctx;
    const input = ctx.createGain();
    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = "lowpass";
    toneFilter.frequency.value = 20000;
    const dry = ctx.createGain();
    const pre = ctx.createGain();
    pre.gain.value = 10;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip;
    const post = ctx.createGain();
    post.gain.value = 0.17;
    const wet = ctx.createGain();
    wet.gain.value = 0;
    const pan = ctx.createStereoPanner();
    const revSend = ctx.createGain();
    revSend.gain.value = 0;
    const delSend = ctx.createGain();
    delSend.gain.value = 0;
    input.connect(toneFilter);
    toneFilter.connect(dry);
    toneFilter.connect(pre);
    pre.connect(shaper);
    shaper.connect(post);
    post.connect(wet);
    dry.connect(pan);
    wet.connect(pan);
    pan.connect(id !== "drums" && TRACK_IDS.includes(id) && e.ch.drums ? e.ch.drums.input : e.master);
    pan.connect(revSend);
    revSend.connect(e.reverb);
    pan.connect(delSend);
    delSend.connect(e.echo);
    let analyser = null;
    if (e.live) {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      pan.connect(analyser);
    }
    return { input, toneFilter, dry, wet, pan, revSend, delSend, analyser };
  }

  function ensureChannels(e) {
    if (!e.ch.drums) e.ch.drums = makeChannel(e, "drums");
    channels().forEach((id) => { if (!e.ch[id]) e.ch[id] = makeChannel(e, id); });
  }

  function buildEngine(ctx, dest, live) {
    const master = ctx.createGain();
    master.connect(dest);
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse(ctx);
    const revReturn = ctx.createGain();
    revReturn.gain.value = 0.8;
    reverb.connect(revReturn);
    revReturn.connect(master);
    const echo = ctx.createDelay(2);
    const echoFeedback = ctx.createGain();
    echoFeedback.gain.value = 0.38;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = "lowpass";
    echoTone.frequency.value = 3200;
    echo.connect(echoTone);
    echoTone.connect(echoFeedback);
    echoFeedback.connect(echo);
    echoTone.connect(master);
    let masterAnalyser = null;
    if (live) {
      masterAnalyser = ctx.createAnalyser();
      masterAnalyser.fftSize = 512;
      master.connect(masterAnalyser);
    }
    const e = { ctx, master, ch: {}, reverb, echo, masterAnalyser, live, sources: [] };
    ensureChannels(e);
    applyMixer(e);
    return e;
  }

  // Who can be heard. A solo silences everything else, but a drum voice and the drum bus share:
  // soloing the Kick lets the kick through the Drums bus, and soloing the bus lets every voice through.
  function audibleFlags() {
    const ids = channels();
    const soloAny = ids.some((id) => S.mixer[id].solo);
    const voiceSolo = TRACK_IDS.some((id) => S.mixer[id].solo);
    const flags = {};
    ids.forEach((id) => {
      const m = S.mixer[id];
      let ok = !m.mute;
      if (soloAny) {
        if (TRACK_IDS.includes(id)) ok = ok && (m.solo || S.mixer.drums.solo);
        else if (id === "drums") ok = ok && (m.solo || voiceSolo);
        else ok = ok && m.solo;
      }
      flags[id] = ok;
    });
    return flags;
  }

  function applyMixer(e) {
    ensureChannels(e);
    const flags = audibleFlags();
    const now = e.ctx.currentTime;
    const set = (param, value) => { if (e.live) param.setTargetAtTime(value, now, 0.01); else param.value = value; };
    channels().forEach((id) => {
      const m = S.mixer[id];
      const c = e.ch[id];
      set(c.input.gain, flags[id] ? m.vol : 0);
      set(c.pan.pan, m.pan);
      set(c.toneFilter.frequency, toneHz(m.tone === undefined ? 1 : m.tone));
      set(c.wet.gain, m.drive || 0);
      set(c.dry.gain, 1 - 0.6 * (m.drive || 0));
      set(c.revSend.gain, (m.rev || 0) * 0.9);
      set(c.delSend.gain, (m.del || 0) * 0.9);
    });
    set(e.master.gain, S.master);
    e.echo.delayTime.value = Math.min(1.9, stepLength() * 3); // a dotted eighth, so the echoes sit in time
  }

  let live = null;
  function engine() {
    if (!live) {
      const ctx = K.getCtx();
      live = buildEngine(ctx, K.getMix(), true);
    }
    ensureChannels(live);
    return live;
  }

  // Long sounds (samples and recordings) have to be silenced by hand when you stop or jump.
  function keep(e, src, gain) {
    if (!e.live) return;
    e.sources.push({ src, gain });
    src.onended = () => { e.sources = e.sources.filter((s) => s.src !== src); };
  }

  function killSources() {
    if (!live) return;
    const now = live.ctx.currentTime;
    live.sources.forEach(({ src, gain }) => {
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0, now, 0.01);
        src.stop(now + 0.08);
      } catch (error) { /* already finished */ }
    });
    live.sources = [];
  }

  function hitDrum(e, id, time, vel, via) {
    const g = e.ctx.createGain();
    g.gain.value = vel;
    g.connect(e.ch[via || id].input);
    VOICES[id](e.ctx, g, time);
  }

  function noteOpts(n, trk) {
    return { glide: n.glide || 0, fadeIn: (n.fadeIn || 0) / 100, fadeOut: (n.fadeOut || 0) / 100, release: trk ? trk.release || 0 : 0 };
  }

  // A note that ends while the sustain pedal is down keeps ringing until the pedal comes up.
  function pedalHold(trk, n, stepLen) {
    const end = n.start + n.len;
    for (let i = 0; i < trk.pedal.length; i++) {
      const p = trk.pedal[i];
      if (end > p.start && end <= p.start + p.len) return (p.start + p.len - end) * stepLen;
    }
    return 0;
  }

  function playSample(e, trk, midi, time, seconds, vel, o) {
    const s = trk.sample;
    const buffer = s && audio.buffers[s.id];
    if (!buffer) return;
    const src = e.ctx.createBufferSource();
    src.buffer = buffer;
    const rate = Math.pow(2, (midi - (s.root === undefined ? 60 : s.root)) / 12);
    const glide = o && o.glide ? o.glide : 0;
    src.playbackRate.setValueAtTime(rate, time);
    const whole = buffer.duration / rate;
    const length = s.whole === false ? Math.max(0.05, seconds) : whole;
    if (glide) src.playbackRate.exponentialRampToValueAtTime(rate * Math.pow(2, glide / 12), time + length);
    const g = e.ctx.createGain();
    const peak = 0.2 + 0.8 * vel;
    const fi = o ? o.fadeIn || 0 : 0;
    const fo = o ? Math.min(1 - fi, o.fadeOut || 0) : 0;
    g.gain.setValueAtTime(fi > 0 ? 0.0001 : peak, time);
    if (fi > 0) g.gain.linearRampToValueAtTime(peak, time + fi * length);
    if (fo > 0) {
      g.gain.setValueAtTime(peak, time + length - fo * length);
      g.gain.linearRampToValueAtTime(0.0001, time + length);
    } else if (s.whole === false) {
      g.gain.setValueAtTime(peak, time + Math.max(0, length - 0.04));
      g.gain.linearRampToValueAtTime(0.0001, time + length);
    }
    src.connect(g);
    g.connect(e.ch[trk.id].input);
    src.start(time);
    src.stop(time + length + 0.05);
    keep(e, src, g);
  }

  function playClip(e, trk, clip, time, offset) {
    const buffer = audio.buffers[clip.bufferId];
    if (!buffer || offset >= buffer.duration) return;
    const src = e.ctx.createBufferSource();
    src.buffer = buffer;
    const g = e.ctx.createGain();
    g.gain.value = clip.gain === undefined ? 1 : clip.gain;
    src.connect(g);
    g.connect(e.ch[trk.id].input);
    src.start(time, offset || 0);
    keep(e, src, g);
  }

  function playKey(e, midi, time, dur, vel, inst, opts, trk) {
    trk = trk || noteTrack();
    if (!trk || !e.ch[trk.id]) return;
    if (trk.type === "sampler") { playSample(e, trk, midi, time, dur, vel, opts); return; }
    K.noteInto(e.ctx, e.ch[trk.id].input, midi, time, dur, 0.04 + 0.14 * vel, inst || trk.inst || K.getInstrument(), opts);
  }

  function click(e, time, accent) {
    const osc = e.ctx.createOscillator();
    const g = e.ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1100;
    g.gain.setValueAtTime(accent ? 0.22 : 0.12, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(g);
    g.connect(e.master);
    osc.start(time);
    osc.stop(time + 0.06);
  }

  function scheduleStepInto(e, step, time, stepLen) {
    const ds = step % STEPS;
    const firstBar = !(S.sfx && step >= STEPS);
    S.tracks.forEach((trk) => {
      if (trk.type === "drums") {
        if (!firstBar) return;
        TRACK_IDS.forEach((id) => { if (trk.pattern[id][ds]) hitDrum(e, id, time, 1, trk.builtin ? null : trk.id); });
      } else if (trk.type === "audio") {
        trk.clips.forEach((c) => { if (Math.floor(c.start) === step) playClip(e, trk, c, time + (c.start - step) * stepLen, 0); });
      } else {
        trk.notes.forEach((n) => {
          if (n.start !== step) return;
          playKey(e, n.midi, time + (n.off || 0) * stepLen, Math.max(0.08, n.len * stepLen + pedalHold(trk, n, stepLen)), n.vel, n.inst, noteOpts(n, trk), trk);
        });
      }
    });
    if (e.live && S.metro && step % 4 === 0) click(e, time, step % STEPS === 0);
  }

  // jumping into the middle of a clip: start it part-way through
  function resumeClips(e, from, time) {
    const sl = stepLength();
    S.tracks.forEach((trk) => {
      if (trk.type !== "audio") return;
      trk.clips.forEach((c) => {
        const b = audio.buffers[c.bufferId];
        if (b && c.start < from && from < c.start + b.duration / sl) playClip(e, trk, c, time, (from - c.start) * sl);
      });
    });
  }

  // ---------- the clock ----------
  let playing = false;
  let recording = false;
  let timer = null;
  let frameId = null;
  let nextStep = 0;
  let nextTime = 0;
  let queue = [];     // steps that are scheduled but not yet shown
  let lit = -1;
  let curStep = 0;    // the step that is sounding now
  let curTime = 0;    // when it started (audio clock)
  let paused = false;     // stopped in the middle, ready to carry on
  let resumeStep = 0;     // where Resume picks up

  function scheduler() {
    const e = engine();
    while (nextTime < e.ctx.currentTime + SCHEDULE_AHEAD) {
      scheduleStepInto(e, nextStep, nextTime, stepLength());
      queue.push({ step: nextStep, time: nextTime });
      nextTime += stepLength();
      nextStep = (nextStep + 1) % totalSteps();
    }
  }

  function showStep(step) {
    TRACK_IDS.forEach((id) => {
      if (lit >= 0) stepButtons[id][lit].classList.remove("studio-grid-step-now");
      if (step >= 0) stepButtons[id][step % STEPS].classList.add("studio-grid-step-now");
    });
    lit = step >= 0 ? step % STEPS : -1;
  }

  // where we are right now, in steps (with a fraction), for recording and the playhead
  function position() {
    if (!playing) return paused ? resumeStep : 0;
    const e = engine();
    const frac = Math.max(0, Math.min(1, (e.ctx.currentTime - curTime) / stepLength()));
    return curStep + frac;
  }

  function start(from) {
    const e = engine();
    killSources();
    clearInterval(timer);
    from = from > 0 ? from % totalSteps() : 0;
    playing = true;
    paused = false;
    nextStep = Math.floor(from);
    curStep = nextStep;
    nextTime = e.ctx.currentTime + 0.06;
    curTime = nextTime;
    queue = [];
    resumeClips(e, from, nextTime);
    scheduler();
    timer = setInterval(scheduler, LOOKAHEAD_MS);
    playButton.textContent = "❚❚ Pause";
    playButton.setAttribute("aria-pressed", "true");
    dirty = true;
  }

  // Pause keeps the place; Play then reads "Resume" and carries on from the same step.
  function pause() {
    if (!playing) return;
    resumeStep = position();
    playing = false;
    paused = true;
    clearInterval(timer);
    queue = [];
    killSources();
    showStep(Math.floor(resumeStep));
    playButton.textContent = "▶ Resume";
    playButton.setAttribute("aria-pressed", "false");
    setRecording(false);
    finishAudioRecording();
    dirty = true;
  }

  const playPause = () => (playing ? pause() : start(paused ? resumeStep : 0));

  function stop() {
    playing = false;
    paused = false;
    resumeStep = 0;
    clearInterval(timer);
    queue = [];
    killSources();
    showStep(-1);
    curStep = 0;
    playButton.textContent = "▶ Play";
    playButton.setAttribute("aria-pressed", "false");
    setRecording(false);
    finishAudioRecording();
    dirty = true;
  }

  // Jump to a place on the ruler. While playing it carries on from there; otherwise Play resumes from there.
  function seek(step) {
    step = clamp(Math.round(step), 0, totalSteps() - 1);
    if (playing) { start(step); return; }
    resumeStep = step;
    paused = step > 0;
    showStep(step > 0 ? step : -1);
    playButton.textContent = step > 0 ? "▶ Resume" : "▶ Play";
    dirty = true;
  }

  function setRecording(on) {
    recording = on;
    recordButton.setAttribute("aria-pressed", String(on));
    recordButton.textContent = on ? "● Recording" : "● Record";
  }

  // ---------- drawing the grid from the data ----------
  function paint() {
    const pattern = drumTrack().pattern;
    TRACK_IDS.forEach((id) => {
      for (let i = 0; i < STEPS; i++) {
        stepButtons[id][i].setAttribute("aria-pressed", String(pattern[id][i]));
      }
      grid.querySelector('.studio-grid-mute[data-track="' + id + '"]')
        .setAttribute("aria-pressed", String(S.mixer[id].mute));
    });
    const label = $("studio-seq-owner");
    if (label) label.textContent = drumTrack().name;
  }

  // ---------- remembering, and undo ----------
  function serialize() {
    return {
      v: 2, bars: S.bars, snap: S.snap, bpm: Number(bpmInput.value), master: S.master, pads: S.pads, scale: S.scale,
      sfx: S.sfx, metro: S.metro, nextId, mixer: S.mixer,
      tracks: S.tracks.map((t) => ({
        id: t.id, type: t.type, name: t.name, inst: t.inst, notes: t.notes, pedal: t.pedal, rollBase: t.rollBase,
        release: t.release, sample: t.sample, clips: t.clips, pattern: t.pattern, builtin: t.builtin,
      })),
    };
  }

  const hist = { stack: [], idx: -1, at: 0, busy: false };

  function remember() {
    const text = JSON.stringify(serialize());
    try { localStorage.setItem(STORE_KEY, text); } catch (error) { /* private window: just don't remember */ }
    if (hist.busy || text === hist.stack[hist.idx]) return;
    const now = Date.now();
    if (hist.idx > 0 && now - hist.at < 350 && hist.idx === hist.stack.length - 1) hist.stack[hist.idx] = text; // a slider drag is one step
    else {
      hist.stack.length = hist.idx + 1;
      hist.stack.push(text);
      if (hist.stack.length > 120) hist.stack.shift();
      hist.idx = hist.stack.length - 1;
    }
    hist.at = now;
    syncHistoryButtons();
  }
  const save = remember;

  function syncHistoryButtons() {
    const undo = $("studio-undo"), redo = $("studio-redo");
    if (undo) undo.disabled = hist.idx <= 0;
    if (redo) redo.disabled = hist.idx >= hist.stack.length - 1;
  }

  function historyStep(dir) {
    const to = hist.idx + dir;
    if (to < 0 || to >= hist.stack.length) return;
    hist.idx = to;
    hist.busy = true;
    try {
      applyState(JSON.parse(hist.stack[to]));
      try { localStorage.setItem(STORE_KEY, hist.stack[to]); } catch (error) { /* fine */ }
    } finally { hist.busy = false; }
    hist.at = 0;
    syncHistoryButtons();
  }
  const undo = () => historyStep(-1);
  const redo = () => historyStep(1);

  function cleanNotes(list, limit) {
    return (Array.isArray(list) ? list : [])
      .filter((n) => n && n.midi >= 21 && n.midi <= 108 && n.start >= 0 && n.len > 0 && n.start < limit)
      .map((n) => ({
        midi: n.midi | 0, start: n.start | 0, len: Math.max(1, Math.min(n.len | 0, limit - (n.start | 0))),
        vel: clamp(Number(n.vel) || 0.8, 0.05, 1), inst: HUES[n.inst] !== undefined ? n.inst : undefined,
        glide: clamp(Math.round(Number(n.glide)) || 0, -48, 48),
        fadeIn: clamp(Math.round(Number(n.fadeIn)) || 0, 0, 100),
        fadeOut: clamp(Math.round(Number(n.fadeOut)) || 0, 0, 100),
        off: clamp(Number(n.off) || 0, -0.45, 0.45),
      }));
  }

  function cleanMix(m) {
    const base = freshMix();
    if (!m || typeof m !== "object") return base;
    return {
      vol: Number.isFinite(Number(m.vol)) ? clamp(Number(m.vol), 0, 1) : 0.8, pan: clamp(Number(m.pan), -1, 1) || 0, mute: m.mute === true, solo: m.solo === true,
      rev: clamp(Number(m.rev), 0, 1) || 0, del: clamp(Number(m.del), 0, 1) || 0, drive: clamp(Number(m.drive), 0, 1) || 0,
      tone: m.tone === undefined ? 1 : clamp(Number(m.tone), 0, 1),
    };
  }

  // Put a saved project (or an undo step) back. Understands the first Studio's format too.
  function applyState(saved, wantedActive) {
    if (!saved || typeof saved !== "object") return;
    const keepActive = wantedActive !== undefined ? wantedActive : S.active;
    S.tracks = [];
    S.mixer = {};
    TRACK_IDS.forEach((id) => { S.mixer[id] = freshMix(); });
    S.bars = [1, 2, 4, 8, 16].includes(saved.bars) ? saved.bars : 1;
    const limit = totalSteps();
    const savedMix = saved.mixer || {};
    TRACK_IDS.forEach((id) => { S.mixer[id] = cleanMix(savedMix[id]); if (saved.muted && saved.muted[id]) S.mixer[id].mute = true; });

    if (Array.isArray(saved.tracks) && saved.tracks.length) {
      saved.tracks.forEach((st) => {
        if (!st || !KINDS[st.type]) return;
        const id = typeof st.id === "string" && /^[a-z0-9]{1,12}$/.test(st.id) ? st.id : null;
        if (id && trackById(id)) return;
        const t = newTrack(st.type, String(st.name || "").slice(0, 30) || undefined, id || undefined);
        if (HUES[st.inst] !== undefined) t.inst = st.inst;
        t.notes = cleanNotes(st.notes, limit);
        t.pedal = (Array.isArray(st.pedal) ? st.pedal : []).filter((p) => p && p.start >= 0 && p.len >= 1 && p.start < limit)
          .map((p) => ({ start: p.start | 0, len: Math.min(p.len | 0, limit - (p.start | 0)) }));
        if (st.rollBase >= 12 && st.rollBase <= 84) t.rollBase = st.rollBase | 0;
        t.release = clamp(Number(st.release) || 0, 0, 4);
        if (st.sample && typeof st.sample.id === "string") {
          t.sample = { id: st.sample.id.slice(0, 40), name: String(st.sample.name || "sample").slice(0, 60),
            root: clamp(st.sample.root | 0, 0, 127) || 60, whole: st.sample.whole !== false };
        }
        t.clips = (Array.isArray(st.clips) ? st.clips : []).filter((c) => c && typeof c.bufferId === "string").slice(0, 40)
          .map((c) => ({ id: String(c.id || c.bufferId).slice(0, 40), bufferId: c.bufferId.slice(0, 40), name: String(c.name || "clip").slice(0, 60),
            start: Math.max(0, Number(c.start) || 0), gain: clamp(c.gain === undefined ? 1 : Number(c.gain), 0, 2) }));
        if (t.type === "drums" && st.pattern) {
          TRACK_IDS.forEach((v) => {
            if (Array.isArray(st.pattern[v])) for (let i = 0; i < STEPS; i++) t.pattern[v][i] = st.pattern[v][i] === true;
          });
        }
        t.builtin = st.builtin === true && t.id === "drums";
        S.mixer[t.id] = cleanMix(savedMix[t.id]);
        S.tracks.push(t);
      });
    } else {
      // the first Studio kept one drum pattern and one list of notes
      const drums = newTrack("drums", "Drum Machine", "drums");
      drums.builtin = true;
      TRACK_IDS.forEach((v) => {
        if (saved.pattern && Array.isArray(saved.pattern[v])) for (let i = 0; i < STEPS; i++) drums.pattern[v][i] = saved.pattern[v][i] === true;
      });
      const keys = newTrack("inst", "Keys");
      keys.notes = cleanNotes(saved.notes, limit);
      if (saved.rollBase >= 24 && saved.rollBase <= 84) keys.rollBase = saved.rollBase | 0;
      S.mixer.drums = freshMix();
      S.mixer[keys.id] = cleanMix(savedMix.keys);
      S.tracks.push(drums, keys);
    }
    if (!S.tracks.some((t) => t.builtin)) {
      const drums = newTrack("drums", "Drum Machine", "drums");
      drums.builtin = true;
      S.mixer.drums = S.mixer.drums || freshMix();
      S.tracks.unshift(drums);
    }
    if (!S.tracks.some(isNoteKind)) S.tracks.push(newTrack("inst", "Keys"));
    S.active = trackById(keepActive) ? keepActive : (S.tracks.find(isNoteKind) || S.tracks[0]).id;
    lastDrumId = (S.tracks.find((t) => t.type === "drums" && t.id === S.active) || S.tracks.find((t) => t.builtin)).id;
    lastNoteId = (S.tracks.find((t) => t.id === S.active && isNoteKind(t)) || S.tracks.find(isNoteKind)).id;
    nextId = Math.max(nextId, Number(saved.nextId) || 1);

    S.master = typeof saved.master === "number" ? clamp(saved.master, 0, 1) : 0.9;
    if (Array.isArray(saved.pads) && saved.pads.length === 16) S.pads = saved.pads.map((id, i) => (TRACK_IDS.includes(id) ? id : S.pads[i]));
    if ([1, 2, 4].includes(saved.snap)) S.snap = saved.snap;
    const sc = saved.scale;
    if (sc && Array.isArray(sc.pcs) && sc.pcs.length >= 5 && sc.pcs.every((x) => x >= 0 && x < 12) && sc.show !== false) {
      S.scale = { root: sc.root | 0, name: String(sc.name || "Scale").slice(0, 30), pcs: sc.pcs.map((x) => x | 0), show: true };
    } else S.scale = { root: sc && sc.root >= 0 && sc.root < 12 ? sc.root | 0 : 2, name: "Off", pcs: [], show: false };
    const bpm = Number(saved.bpm);
    if (bpm >= 60 && bpm <= 300) bpmInput.value = bpm;
    S.sfx = saved.sfx === true;
    S.metro = saved.metro === true;
    S.tracks.forEach((t) => { if (t.sample) ensureAudio(t.sample.id); t.clips.forEach((c) => ensureAudio(c.bufferId)); });
    if (typeof rebuildUi === "function") rebuildUi();
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      let active = "";
      try { active = localStorage.getItem(STORE_KEY + "-active") || ""; } catch (error) { /* fine */ }
      if (saved) applyState(saved, active);
    } catch (error) { /* bad data: start empty */ }
  }

  // ---------- setters (one place changes things, so the screen never disagrees with the sound) ----------
  function setBpm(value) {
    const bpm = Math.round(clamp(value, 60, 300));
    bpmInput.value = bpm;
    bpmValue.textContent = bpm;
    if (live) applyMixer(live);
    save();
  }

  function setBars(bars) {
    S.bars = bars;
    barsSelect.value = String(bars);
    const limit = totalSteps();
    S.tracks.forEach((t) => {
      t.notes = t.notes.filter((n) => n.start < limit).map((n) => ({ ...n, len: Math.min(n.len, limit - n.start) }));
      t.pedal = t.pedal.filter((p) => p.start < limit).map((p) => ({ ...p, len: Math.min(p.len, limit - p.start) }));
    });
    if (sel || selSet.size) select(null);
    if (playing) nextStep = nextStep % limit;
    if (resumeStep >= limit) resumeStep = 0;
    sizeRoll();
    drawProgress();
    dirty = true;
    save();
  }

  const mixerEls = {};
  function syncMixerUi(id) {
    const els = mixerEls[id];
    const m = id === "master" ? { vol: S.master, pan: 0, mute: false, solo: false } : S.mixer[id];
    if (els) {
      els.fader.value = Math.round(m.vol * 100);
      if (els.pan) els.pan.value = Math.round(m.pan * 100);
      if (els.mute) els.mute.setAttribute("aria-pressed", String(m.mute));
      if (els.solo) els.solo.setAttribute("aria-pressed", String(m.solo));
    }
    const row = trackEls[id];
    if (row && id !== "master") {
      row.vol.value = Math.round(m.vol * 100);
      row.pan.value = Math.round(m.pan * 100);
      row.mute.setAttribute("aria-pressed", String(m.mute));
      row.solo.setAttribute("aria-pressed", String(m.solo));
    }
  }

  function mixChanged() {
    if (live) applyMixer(live);
    channels().forEach(syncMixerUi);
    syncMixerUi("master");
    paint();
    save();
  }

  function setVol(id, value) {
    if (id === "master") S.master = clamp(value, 0, 1);
    else if (S.mixer[id]) S.mixer[id].vol = clamp(value, 0, 1);
    mixChanged();
  }
  function setPan(id, value) { if (S.mixer[id]) { S.mixer[id].pan = clamp(value, -1, 1); mixChanged(); } }
  function toggleMute(id) { if (S.mixer[id]) { S.mixer[id].mute = !S.mixer[id].mute; mixChanged(); } }
  function toggleSolo(id) { if (S.mixer[id]) { S.mixer[id].solo = !S.mixer[id].solo; mixChanged(); } }
  function setFx(id, key, value) {
    if (!S.mixer[id]) return;
    S.mixer[id][key] = clamp(value, 0, 1);
    if (live) applyMixer(live);
    save();
  }

  // ---------- pads ----------
  const padEls = [];
  const padsBox = $("studio-pads");
  S.pads.forEach((voice, i) => {
    const wrap = document.createElement("div");
    wrap.className = "studio-pad-wrap";
    const pad = document.createElement("button");
    pad.type = "button";
    pad.className = "studio-pad";
    pad.dataset.target = "pad:" + i;
    pad.innerHTML = '<span class="studio-pad-num">' + (i + 1) + "</span>";
    const select = document.createElement("select");
    select.className = "studio-pad-voice";
    select.setAttribute("aria-label", "Sound for pad " + (i + 1));
    TRACKS.forEach((t) => {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = t.name;
      select.appendChild(o);
    });
    select.value = voice;
    select.addEventListener("change", () => { S.pads[i] = select.value; save(); });
    pad.addEventListener("pointerdown", (event) => {
      if (learning) return;
      event.preventDefault();
      hitPad(i, 0.85);
    });
    wrap.append(pad, select);
    padsBox.appendChild(wrap);
    padEls.push({ pad, select });
  });

  function flash(el) {
    el.classList.add("is-hit");
    setTimeout(() => el.classList.remove("is-hit"), 110);
  }

  function hitPad(i, vel) {
    const voice = S.pads[i];
    const e = engine();
    const owner = drumTrack();
    hitDrum(e, voice, e.ctx.currentTime, 0.4 + 0.6 * vel, owner.builtin ? null : owner.id);
    flash(padEls[i].pad);
    if (recording && playing) {
      const at = Math.round(position()) % totalSteps();
      owner.pattern[voice][at % STEPS] = true;
      paint();
      save();
    }
  }

  // ---------- piano roll ----------
  const roll = $("studio-roll");
  const rollScroll = $("studio-roll-scroll");
  const rollCtx = roll.getContext("2d");
  const LABEL_W = 58;
  const ROW_H = 16;
  const ROWS = 36;
  const HEAD = 22;     // the ruler along the top
  const FOOT = 28;     // the sustain pedal lane along the bottom
  const BLACK = [1, 3, 6, 8, 10];
  let stepW = 24;
  let dirty = true;
  let lastLen = 2;
  let drag = null;
  let sel = null;            // the note the editor is showing
  let selSet = new Set();    // every selected note
  let clipboard = null;      // copied notes
  let pasteAt = 0;

  function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  const rowsHeight = () => ROWS * ROW_H;
  const rollHeight = () => HEAD + rowsHeight() + FOOT;

  function sizeRoll() {
    const avail = Math.max(300, rollScroll.clientWidth - LABEL_W);
    stepW = Math.max(22, Math.floor(avail / totalSteps()));
    const w = LABEL_W + stepW * totalSteps();
    const h = rollHeight();
    const dpr = window.devicePixelRatio || 1;
    roll.style.width = w + "px";
    roll.style.height = h + "px";
    roll.width = Math.round(w * dpr);
    roll.height = Math.round(h * dpr);
    rollCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  const rowOf = (midi) => ROWS - 1 - (midi - S.rollBase);
  const midiOf = (row) => S.rollBase + ROWS - 1 - row;

  function noteRect(n) {
    const r = rowOf(n.midi);
    return { x: LABEL_W + (n.start + (n.off || 0)) * stepW, y: r * ROW_H, w: Math.max(4, n.len * stepW - 1), r };
  }

  function drawNote(n, hue, alpha, selected) {
    const { x, w, r } = noteRect(n);
    if (r < 0 || r >= ROWS) return;
    const top = r * ROW_H + 1;
    rollCtx.fillStyle = "hsla(" + hue + ",85%," + Math.round(48 + 14 * (1 - n.vel)) + "%," + alpha + ")";
    rollCtx.fillRect(x, top, w, ROW_H - 2);
    if (alpha < 0.9) return;
    const fi = (n.fadeIn || 0) / 100;
    const fo = (n.fadeOut || 0) / 100;
    if (fi > 0) {
      const g = rollCtx.createLinearGradient(x, 0, x + w * fi, 0);
      g.addColorStop(0, "rgba(0,0,0,0.7)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      rollCtx.fillStyle = g;
      rollCtx.fillRect(x, top, w * fi, ROW_H - 2);
    }
    if (fo > 0) {
      const g = rollCtx.createLinearGradient(x + w, 0, x + w - w * fo, 0);
      g.addColorStop(0, "rgba(0,0,0,0.7)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      rollCtx.fillStyle = g;
      rollCtx.fillRect(x + w - w * fo, top, w * fo, ROW_H - 2);
    }
    rollCtx.strokeStyle = selected ? "#ffffff" : "rgba(0,0,0,0.5)";
    rollCtx.lineWidth = n === sel ? 2.5 : selected ? 2 : 1;
    rollCtx.strokeRect(x + 0.5, top + 0.5, w - 1, ROW_H - 3);
    rollCtx.lineWidth = 1;
    if (n.glide) {
      rollCtx.strokeStyle = "rgba(255,255,255,0.95)";
      rollCtx.lineWidth = 2;
      rollCtx.beginPath();
      rollCtx.moveTo(x + 2, r * ROW_H + ROW_H / 2);
      rollCtx.lineTo(x + w - 2, r * ROW_H + ROW_H / 2 - n.glide * ROW_H);
      rollCtx.stroke();
      rollCtx.lineWidth = 1;
    }
  }

  function drawRoll() {
    const w = LABEL_W + stepW * totalSteps();
    const h = rowsHeight();
    const light = document.documentElement.dataset.theme === "light";
    const ink = light ? "#1a0b0f" : "#f3e9e9";
    const trk = noteTrack();
    rollCtx.clearRect(0, 0, w, rollHeight());
    rollCtx.save();
    rollCtx.translate(0, HEAD);
    for (let r = 0; r < ROWS; r++) {
      const midi = midiOf(r);
      const black = BLACK.includes(midi % 12);
      rollCtx.fillStyle = black
        ? (light ? "rgba(80,10,12,0.10)" : "rgba(0,0,0,0.38)")
        : (light ? "rgba(80,10,12,0.03)" : "rgba(255,238,238,0.04)");
      rollCtx.fillRect(LABEL_W, r * ROW_H, w - LABEL_W, ROW_H);
    }
    if (S.scale.show) {
      for (let r = 0; r < ROWS; r++) {
        const pc = midiOf(r) % 12;
        if (!S.scale.pcs.includes(pc)) continue;
        const root = pc === S.scale.root;
        rollCtx.fillStyle = root ? (light ? "rgba(190,120,0,0.30)" : "rgba(255,200,80,0.20)")
          : (light ? "rgba(190,120,0,0.12)" : "rgba(255,200,80,0.07)");
        rollCtx.fillRect(LABEL_W, r * ROW_H, w - LABEL_W, ROW_H);
      }
    }
    if (trk && trk.type === "sampler" && trk.sample) {
      const rr = rowOf(trk.sample.root === undefined ? 60 : trk.sample.root);
      if (rr >= 0 && rr < ROWS) {
        rollCtx.fillStyle = "rgba(80,220,170,0.16)";
        rollCtx.fillRect(LABEL_W, rr * ROW_H, w - LABEL_W, ROW_H);
      }
    }
    drawKeys(h);
    for (let s = 0; s <= totalSteps(); s++) {
      const x = LABEL_W + s * stepW + 0.5;
      rollCtx.strokeStyle = s % STEPS === 0 ? (light ? "rgba(80,10,12,0.6)" : "rgba(255,238,238,0.5)")
        : s % 4 === 0 ? (light ? "rgba(80,10,12,0.3)" : "rgba(255,238,238,0.2)")
        : (light ? "rgba(80,10,12,0.1)" : "rgba(255,238,238,0.07)");
      rollCtx.beginPath();
      rollCtx.moveTo(x, 0);
      rollCtx.lineTo(x, h);
      rollCtx.stroke();
    }
    // the other tracks' notes, faint, so you can write against them
    S.tracks.forEach((other) => {
      if (other === trk || !isNoteKind(other)) return;
      other.notes.forEach((n) => drawNote(n, 215, 0.2, false));
    });
    if (trk) trk.notes.forEach((n) => drawNote(n, HUES[n.inst || trk.inst] || (trk.type === "sampler" ? HUES.sample : 355), 0.95, selSet.has(n)));
    if (drag && drag.mode === "marquee") {
      const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1) - HEAD;
      rollCtx.fillStyle = "rgba(255,255,255,0.12)";
      rollCtx.strokeStyle = "rgba(255,255,255,0.8)";
      rollCtx.setLineDash([4, 3]);
      rollCtx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      rollCtx.strokeRect(x + 0.5, y + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      rollCtx.setLineDash([]);
    }
    rollCtx.restore();

    // the ruler: bar numbers, beat ticks, and a click-to-jump strip
    rollCtx.fillStyle = light ? "rgba(80,10,12,0.08)" : "rgba(255,238,238,0.07)";
    rollCtx.fillRect(0, 0, w, HEAD);
    rollCtx.fillStyle = light ? "#5a1a1f" : "#cdbdbd";
    rollCtx.font = "600 10px sans-serif";
    rollCtx.textBaseline = "middle";
    rollCtx.fillText("Bar", 8, HEAD / 2);
    for (let s = 0; s <= totalSteps(); s += 4) {
      const x = LABEL_W + s * stepW + 0.5;
      rollCtx.strokeStyle = light ? "rgba(80,10,12,0.4)" : "rgba(255,238,238,0.35)";
      rollCtx.beginPath();
      rollCtx.moveTo(x, s % STEPS === 0 ? 3 : HEAD - 7);
      rollCtx.lineTo(x, HEAD);
      rollCtx.stroke();
      if (s % STEPS === 0 && s < totalSteps()) rollCtx.fillText(String(s / STEPS + 1), x + 4, HEAD / 2);
    }

    // the sustain pedal lane
    const fy = HEAD + h;
    rollCtx.fillStyle = light ? "rgba(80,10,12,0.06)" : "rgba(255,238,238,0.05)";
    rollCtx.fillRect(LABEL_W, fy, w - LABEL_W, FOOT);
    rollCtx.fillStyle = light ? "#5a1a1f" : "#cdbdbd";
    rollCtx.fillText("Pedal", 8, fy + FOOT / 2);
    if (trk && trk.type !== "sampler") {
      trk.pedal.forEach((p) => {
        const x = LABEL_W + p.start * stepW;
        rollCtx.fillStyle = "rgba(255,200,80,0.85)";
        rollCtx.fillRect(x, fy + 4, Math.max(4, p.len * stepW - 1), FOOT - 8);
        rollCtx.fillStyle = "#2a1a00";
        rollCtx.font = "700 10px sans-serif";
        rollCtx.fillText("sustain", x + 5, fy + FOOT / 2);
        rollCtx.font = "600 10px sans-serif";
      });
    } else {
      rollCtx.fillStyle = "rgba(255,238,238,0.3)";
      rollCtx.fillText("not used by a sampler", LABEL_W + 8, fy + FOOT / 2);
    }

    if (playing || paused) {
      const x = LABEL_W + position() * stepW;
      rollCtx.fillStyle = "#ff3b3b";
      rollCtx.fillRect(x - 1, 0, 2, rollHeight());
      rollCtx.beginPath();
      rollCtx.moveTo(x - 6, 0);
      rollCtx.lineTo(x + 6, 0);
      rollCtx.lineTo(x, 9);
      rollCtx.closePath();
      rollCtx.fill();
    }
    $("studio-roll-range").textContent = K.noteName(S.rollBase) + " – " + K.noteName(S.rollBase + ROWS - 1);
  }

  // The keyboard down the left side: white keys are tall bars, black keys sit on top, a little shorter.
  function drawKeys(h) {
    const half = ROW_H / 2;
    const whiteGrad = rollCtx.createLinearGradient(0, 0, LABEL_W, 0);
    whiteGrad.addColorStop(0, "#fbf6f4");
    whiteGrad.addColorStop(0.85, "#efe6e3");
    whiteGrad.addColorStop(1, "#cfc3c0");
    for (let r = 0; r < ROWS; r++) {
      const midi = midiOf(r);
      if (BLACK.includes(midi % 12)) continue;
      const top = r * ROW_H - (BLACK.includes((midi + 1) % 12) ? half : 0);
      const bottom = (r + 1) * ROW_H + (BLACK.includes((midi + 11) % 12) ? half : 0);
      rollCtx.fillStyle = whiteGrad;
      rollCtx.fillRect(0, Math.max(0, top), LABEL_W - 1, Math.min(h, bottom) - Math.max(0, top) - 1);
      rollCtx.fillStyle = "#8c7b78";
      rollCtx.fillRect(0, Math.min(h, bottom) - 1, LABEL_W - 1, 1);
      if (midi % 12 === 0) {
        rollCtx.fillStyle = "#7a1b22";
        rollCtx.font = "700 10px sans-serif";
        rollCtx.textBaseline = "middle";
        rollCtx.fillText(K.noteName(midi), LABEL_W - 27, r * ROW_H + ROW_H / 2);
      }
    }
    for (let r = 0; r < ROWS; r++) {
      const midi = midiOf(r);
      if (!BLACK.includes(midi % 12)) continue;
      const bw = LABEL_W * 0.62;
      const grad = rollCtx.createLinearGradient(0, 0, bw, 0);
      grad.addColorStop(0, "#2a1a1d");
      grad.addColorStop(0.8, "#0d0506");
      grad.addColorStop(1, "#000");
      rollCtx.fillStyle = grad;
      rollCtx.fillRect(0, r * ROW_H + 1, bw, ROW_H - 2);
      rollCtx.fillStyle = "rgba(255,255,255,0.14)";
      rollCtx.fillRect(0, r * ROW_H + 1, bw - 3, 1);
    }
    rollCtx.fillStyle = "#1b0b0e";
    rollCtx.fillRect(LABEL_W - 1, 0, 1, h);
  }

  function noteAt(midi, step) {
    const notes = S.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.midi === midi && step >= n.start && step < n.start + n.len) return n;
    }
    return null;
  }

  function rollPoint(event) {
    const rect = roll.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const zone = y < HEAD ? "ruler" : y >= HEAD + rowsHeight() ? "foot" : "rows";
    const row = clamp(Math.floor((y - HEAD) / ROW_H), 0, ROWS - 1);
    return { x, y, zone, row, midi: midiOf(row), step: (x - LABEL_W) / stepW };
  }

  function preview(midi) {
    const trk = noteTrack();
    if (!trk) return;
    const e = engine();
    playKey(e, midi, e.ctx.currentTime, 0.4, 0.8, undefined, { release: trk.release || 0 }, trk);
  }

  function deleteNotes(list) {
    const trk = noteTrack();
    if (!trk || !list.length) return;
    const gone = new Set(list);
    trk.notes = trk.notes.filter((n) => !gone.has(n));
    select(null);
    save();
  }

  roll.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const trk = noteTrack();
    if (!trk) return;
    const p = rollPoint(event);
    if (p.zone === "foot") {
      const at = Math.floor(p.step);
      const hit = trk.pedal.find((r) => at >= r.start && at < r.start + r.len);
      if (hit) { trk.pedal.splice(trk.pedal.indexOf(hit), 1); dirty = true; save(); }
      return;
    }
    if (p.zone !== "rows") return;
    const n = noteAt(p.midi, Math.floor(p.step));
    if (n) deleteNotes(selSet.has(n) ? [...selSet] : [n]);
  });

  roll.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const trk = noteTrack();
    if (!trk) return;
    const p = rollPoint(event);
    const total = totalSteps();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (p.zone === "ruler") {
      if (p.x < LABEL_W) return;
      roll.setPointerCapture(event.pointerId);
      drag = { mode: "seek" };
      seek(p.step);
      return;
    }
    if (p.zone === "foot") {
      if (trk.type === "sampler" || p.x < LABEL_W) return;
      const at = clamp(Math.floor(p.step), 0, total - 1);
      const hit = trk.pedal.find((r) => at >= r.start && at < r.start + r.len);
      roll.setPointerCapture(event.pointerId);
      if (hit) {
        const edge = LABEL_W + (hit.start + hit.len) * stepW - p.x < 8;
        drag = { mode: edge ? "pedalresize" : "pedalmove", region: hit, grab: p.step - hit.start };
      } else {
        const begin = Math.floor(at / S.snap) * S.snap;
        const region = { start: begin, len: Math.min(S.snap * 2, total - begin) };
        trk.pedal.push(region);
        drag = { mode: "pedalresize", region, grab: 0 };
      }
      dirty = true;
      return;
    }
    if (p.x < LABEL_W) { preview(p.midi); return; }
    const cell = clamp(Math.floor(p.step), 0, total - 1);
    const snapped = Math.floor(cell / S.snap) * S.snap;
    const hit = noteAt(p.midi, cell);
    roll.setPointerCapture(event.pointerId);
    if (hit && additive) {
      if (selSet.has(hit)) selSet.delete(hit); else selSet.add(hit);
      sel = selSet.has(hit) ? hit : ([...selSet].pop() || null);
      syncEditor();
      dirty = true;
      drag = { mode: "none" };
      return;
    }
    if (hit) {
      if (!selSet.has(hit)) select(hit);
      else { sel = hit; syncEditor(); }
      const edge = LABEL_W + (hit.start + hit.len) * stepW - p.x < 8;
      const group = [...selSet].map((n) => ({ note: n, start0: n.start, len0: n.len, midi0: n.midi }));
      drag = { mode: edge ? "resize" : "move", primary: hit, group, p0: { step: p.step, midi: p.midi }, grab: p.step - hit.start, end0: hit.start + hit.len, lastDm: 0 };
    } else if (S.tool === "select" || additive) {
      drag = { mode: "marquee", x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: additive };
    } else {
      const note = { midi: p.midi, start: snapped, len: Math.min(Math.max(lastLen, S.snap), total - snapped), vel: 0.8, inst: trk.type === "sampler" ? undefined : trk.inst };
      trk.notes.push(note);
      select(note);
      preview(p.midi);
      drag = { mode: "new", primary: note, group: [{ note, start0: note.start, len0: note.len, midi0: note.midi }], grab: 0 };
    }
    dirty = true;
  });

  roll.addEventListener("pointermove", (event) => {
    if (!drag || drag.mode === "none") return;
    const p = rollPoint(event);
    const total = totalSteps();
    if (drag.mode === "seek") { seek(clamp(p.step, 0, total - 1)); return; }
    if (drag.mode === "marquee") { drag.x1 = p.x; drag.y1 = p.y; dirty = true; return; }
    if (drag.mode === "pedalmove") {
      const r = drag.region;
      r.start = clamp(Math.round((p.step - drag.grab) / S.snap) * S.snap, 0, total - r.len);
      dirty = true;
      return;
    }
    if (drag.mode === "pedalresize") {
      const r = drag.region;
      r.len = clamp(Math.round(p.step / S.snap) * S.snap - r.start, S.snap, total - r.start);
      dirty = true;
      return;
    }
    if (drag.mode === "move") {
      const g = drag.group;
      const minStart = Math.min(...g.map((o) => o.start0));
      const maxEnd = Math.max(...g.map((o) => o.start0 + o.len0));
      const minMidi = Math.min(...g.map((o) => o.midi0));
      const maxMidi = Math.max(...g.map((o) => o.midi0));
      const ds = clamp(Math.round((p.step - drag.p0.step) / S.snap) * S.snap, -minStart, total - maxEnd);
      const dm = clamp(p.midi - drag.p0.midi, 21 - minMidi, 108 - maxMidi);
      g.forEach((o) => { o.note.start = o.start0 + ds; o.note.midi = o.midi0 + dm; });
      if (dm !== drag.lastDm) { drag.lastDm = dm; preview(drag.primary.midi); }
    } else {
      const end = Math.round(p.step / S.snap) * S.snap;
      const delta = end - drag.end0;
      drag.group.forEach((o) => {
        o.note.len = clamp(drag.mode === "new" ? end - o.start0 : o.len0 + delta, S.snap, total - o.start0);
      });
    }
    dirty = true;
  });

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === "marquee") {
      const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (w < 4 && h < 4) { if (!d.add) select(null); dirty = true; return; }
      const x0 = (Math.min(d.x0, d.x1) - LABEL_W) / stepW, x1 = (Math.max(d.x0, d.x1) - LABEL_W) / stepW;
      const y0 = (Math.min(d.y0, d.y1) - HEAD) / ROW_H, y1 = (Math.max(d.y0, d.y1) - HEAD) / ROW_H;
      const inside = S.notes.filter((n) => {
        const r = rowOf(n.midi);
        return n.start < x1 && n.start + n.len > x0 && r + 1 > y0 && r < y1;
      });
      selectMany(d.add ? [...selSet, ...inside] : inside);
      return;
    }
    if (d.mode === "seek" || d.mode === "none") return;
    if (d.primary) lastLen = d.primary.len;
    save();
  }
  roll.addEventListener("pointerup", endDrag);
  roll.addEventListener("pointercancel", endDrag);

  $("studio-snap").addEventListener("change", (event) => { S.snap = Number(event.target.value); save(); });
  $("studio-roll-up").addEventListener("click", () => rollShift(12));
  $("studio-roll-down").addEventListener("click", () => rollShift(-12));
  $("studio-roll-clear").addEventListener("click", () => { const t = noteTrack(); if (t) { t.notes = []; t.pedal = []; } select(null); dirty = true; save(); });

  // ---------- shade a scale on the roll (the list comes from the Scales page's data) ----------
  const SCALES = {};
  (SCALE_DATA.length ? SCALE_DATA : [{ name: "Major", steps: [0, 2, 4, 5, 7, 9, 11] }, { name: "Natural minor", steps: [0, 2, 3, 5, 7, 8, 10] }])
    .forEach((s) => { SCALES[s.name] = s.steps; });
  const scaleKey = $("studio-scale-key");
  const scaleMode = $("studio-scale-mode");
  ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"].forEach((n, i) => scaleKey.add(new Option(n, String(i))));
  scaleMode.add(new Option("Off", "Off"));
  Object.keys(SCALES).forEach((n) => scaleMode.add(new Option(n, n)));
  function applyScale() {
    const root = Number(scaleKey.value);
    const steps = SCALES[scaleMode.value];
    S.scale = steps ? { root, name: scaleMode.value, pcs: steps.map((s) => (root + s) % 12), show: true }
      : { root, name: "Off", pcs: [], show: false };
    dirty = true;
    save();
  }
  scaleKey.addEventListener("change", applyScale);
  scaleMode.addEventListener("change", applyScale);

  // ---------- the note editor: sound, volume, slide and fades for one note (or several) ----------
  const instSelect = $("main-keyboard-instrument");
  const ed = {
    box: $("studio-note-editor"), title: $("studio-note-title"), inst: $("studio-note-inst"), scope: $("studio-note-scope"),
    vel: $("studio-note-vel"), glide: $("studio-note-glide"), fadeIn: $("studio-note-fadein"), fadeOut: $("studio-note-fadeout"),
  };
  ed.inst.innerHTML = instSelect.innerHTML;
  ed.box.querySelectorAll("input, select, button").forEach((el) => { el.disabled = true; });

  function select(note) {
    sel = note || null;
    selSet = new Set(note ? [note] : []);
    syncEditor();
  }

  function selectMany(list) {
    const unique = [...new Set(list)];
    selSet = new Set(unique);
    sel = unique.length ? unique[unique.length - 1] : null;
    syncEditor();
  }

  function syncEditor() {
    const note = sel;
    const trk = noteTrack();
    ed.box.classList.toggle("studio-note-editor-empty", !note);
    ed.box.querySelectorAll("input, select, button").forEach((el) => { el.disabled = !note; });
    dirty = true;
    if (!note) { ed.title.textContent = "No note selected"; return; }
    ed.title.textContent = selSet.size > 1
      ? selSet.size + " notes selected"
      : K.noteName(note.midi) + " · " + note.len + " step" + (note.len > 1 ? "s" : "");
    ed.inst.value = note.inst || (trk && trk.inst) || K.getInstrument();
    ed.inst.disabled = !!(trk && trk.type === "sampler");
    ed.vel.value = Math.round(note.vel * 100);
    ed.glide.value = note.glide || 0;
    ed.fadeIn.value = note.fadeIn || 0;
    ed.fadeOut.value = note.fadeOut || 0;
    showEditorValues();
  }

  function showEditorValues() {
    $("studio-note-vel-value").textContent = ed.vel.value + "%";
    const g = Number(ed.glide.value);
    $("studio-note-glide-value").textContent = (g > 0 ? "+" : "") + g + " st";
    $("studio-note-fadein-value").textContent = ed.fadeIn.value + "%";
    $("studio-note-fadeout-value").textContent = ed.fadeOut.value + "%";
  }

  function scopeNotes() {
    if (!sel) return [];
    const trk = noteTrack();
    const own = (n) => n.inst || (trk && trk.inst);
    if (selSet.size > 1 && ed.scope.value === "one") return [...selSet];
    if (ed.scope.value === "sound") return S.notes.filter((n) => own(n) === own(sel));
    if (ed.scope.value === "chord") return S.notes.filter((n) => n.start === sel.start);
    return [sel];
  }

  function edit(change) {
    if (!sel) return;
    scopeNotes().forEach(change);
    showEditorValues();
    dirty = true;
    save();
  }

  ed.inst.addEventListener("change", () => {
    edit((n) => { n.inst = ed.inst.value; });
    setTrackInst(noteTrack(), ed.inst.value); // the next notes you place use the sound you just chose
  });
  ed.vel.addEventListener("input", () => edit((n) => { n.vel = Math.max(0.05, Number(ed.vel.value) / 100); }));
  ed.glide.addEventListener("input", () => edit((n) => { n.glide = Number(ed.glide.value); }));
  ed.fadeIn.addEventListener("input", () => edit((n) => { n.fadeIn = Number(ed.fadeIn.value); }));
  ed.fadeOut.addEventListener("input", () => edit((n) => { n.fadeOut = Number(ed.fadeOut.value); }));
  $("studio-note-hear").addEventListener("click", () => {
    if (!sel) return;
    const trk = noteTrack();
    const e = engine();
    playKey(e, sel.midi, e.ctx.currentTime + 0.02, Math.max(0.08, sel.len * stepLength() + (trk ? pedalHold(trk, sel, stepLength()) : 0)), sel.vel, sel.inst, noteOpts(sel, trk), trk);
  });
  $("studio-note-delete").addEventListener("click", () => deleteNotes(selSet.size ? [...selSet] : [sel]));
  document.addEventListener("keydown", (event) => {
    if (tab !== "roll" || !sel) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
    event.preventDefault();
    deleteNotes([...selSet]);
  });

  function rollShift(delta) {
    S.rollBase = clamp(S.rollBase + delta, 24, 84);
    dirty = true;
    save();
  }

  // ---------- roll tools: move, tidy and copy whole groups of notes ----------
  const toolNotes = () => (selSet.size ? [...selSet] : S.notes);
  function toolDone() { syncEditor(); dirty = true; save(); }

  function transposeNotes(by) {
    const ns = toolNotes();
    if (!ns.length || ns.some((n) => n.midi + by < 21 || n.midi + by > 108)) return;
    ns.forEach((n) => { n.midi += by; });
    preview(ns[0].midi);
    toolDone();
  }

  function quantizeNotes() {
    const total = totalSteps(), q = S.snap;
    toolNotes().forEach((n) => {
      n.start = clamp(Math.round(n.start / q) * q, 0, total - 1);
      n.len = clamp(Math.max(q, Math.round(n.len / q) * q), 1, total - n.start);
      n.off = 0;
    });
    toolDone();
  }

  // Humanize: a little random in the loudness and in the timing, so a pattern stops sounding like a machine.
  function humanizeNotes() {
    toolNotes().forEach((n) => {
      n.vel = clamp(n.vel + (Math.random() - 0.5) * 0.24, 0.15, 1);
      n.off = clamp((Math.random() - 0.5) * 0.4, -0.2, 0.2);
    });
    toolDone();
  }

  function randomVelocity() {
    toolNotes().forEach((n) => { n.vel = 0.4 + Math.random() * 0.6; });
    toolDone();
  }

  // Legato: stretch each note until the next one starts.
  function legatoNotes() {
    const ns = toolNotes().slice().sort((a, b) => a.start - b.start);
    const total = totalSteps();
    ns.forEach((n) => {
      const next = ns.find((o) => o.start > n.start);
      if (next) n.len = Math.max(1, next.start - n.start);
      else n.len = Math.max(n.len, 1);
      n.len = Math.min(n.len, total - n.start);
    });
    toolDone();
  }

  function selectAll() { selectMany(S.notes); }

  function copyNotes(cut) {
    if (!selSet.size) return;
    const ns = [...selSet];
    const from = Math.min(...ns.map((n) => n.start));
    const to = Math.max(...ns.map((n) => n.start + n.len));
    clipboard = { notes: ns.map((n) => ({ ...n, start: n.start - from })), span: to - from };
    pasteAt = to;
    if (cut) deleteNotes(ns);
    syncClipboardButtons();
  }

  // Paste at the playhead; with the playhead at the start, copies land one after another.
  function pasteNotes() {
    const trk = noteTrack();
    if (!clipboard || !trk) return;
    const total = totalSteps();
    let at = (playing || paused) && position() >= 1 ? Math.round(position()) : pasteAt;
    at = Math.floor(at / S.snap) * S.snap;
    if (at + clipboard.span > total) at = Math.max(0, total - clipboard.span);
    const made = clipboard.notes.filter((n) => n.start + at < total).map((n) => ({ ...n, start: n.start + at, len: Math.max(1, Math.min(n.len, total - n.start - at)) }));
    trk.notes.push(...made);
    pasteAt = at + clipboard.span;
    selectMany(made);
    save();
  }

  function syncClipboardButtons() {
    const paste = $("studio-roll-paste");
    if (paste) paste.disabled = !clipboard;
  }

  function setTool(name) {
    S.tool = name;
    $("studio-tool-draw").setAttribute("aria-pressed", String(name === "draw"));
    $("studio-tool-select").setAttribute("aria-pressed", String(name === "select"));
    roll.classList.toggle("studio-roll-select-tool", name === "select");
  }

  const ROLL_ACTIONS = {
    up12: () => transposeNotes(12), up1: () => transposeNotes(1), down1: () => transposeNotes(-1), down12: () => transposeNotes(-12),
    quantize: quantizeNotes, humanize: humanizeNotes, legato: legatoNotes, velocity: randomVelocity,
    all: selectAll, copy: () => copyNotes(false), cut: () => copyNotes(true), paste: pasteNotes,
  };
  document.querySelectorAll("[data-roll-action]").forEach((b) => b.addEventListener("click", () => ROLL_ACTIONS[b.dataset.rollAction]()));
  $("studio-tool-draw").addEventListener("click", () => setTool("draw"));
  $("studio-tool-select").addEventListener("click", () => setTool("select"));

  // ---------- recording the keys ----------
  const held = new Map(); // midi -> { step, time }
  const board = K.createKeyboard($("main-keyboard-keys"), document.querySelector(".main-keyboard-case"));

  board.onNote((midi, isOn) => {
    if (!recording || !playing) return;
    const trk = noteTrack();
    if (!trk) return;
    const e = engine();
    if (isOn) {
      held.set(midi, { step: Math.round(position()) % totalSteps(), time: e.ctx.currentTime });
    } else if (held.has(midi)) {
      const h = held.get(midi);
      held.delete(midi);
      const len = Math.max(1, Math.round((e.ctx.currentTime - h.time) / stepLength()));
      trk.notes.push({ midi, start: h.step, len: Math.min(len, totalSteps() - h.step), vel: 0.8, inst: trk.type === "sampler" ? undefined : trk.inst });
      dirty = true;
      save();
    }
  });

  // ---------- tracks: the list, the settings, adding and removing ----------
  const trackList = $("studio-track-list");
  const settingsBox = $("studio-track-settings");
  const trackEls = {};
  const INST_NAMES = {};
  [...instSelect.options].forEach((o) => { INST_NAMES[o.value] = o.textContent; });

  function kindLabel(t) {
    if (t.type === "drums") return "8 voices";
    if (t.type === "audio") return t.clips.length + (t.clips.length === 1 ? " clip" : " clips");
    if (t.type === "sampler") return t.sample ? t.sample.name : "no sample yet";
    return INST_NAMES[t.inst] || t.inst;
  }

  function renderTracks() {
    trackList.textContent = "";
    Object.keys(trackEls).forEach((k) => delete trackEls[k]);
    S.tracks.forEach((trk) => {
      const row = document.createElement("div");
      row.className = "studio-track-row" + (trk.id === S.active ? " is-active" : "");
      row.dataset.track = trk.id;
      const name = document.createElement("button");
      name.type = "button";
      name.className = "studio-track-name";
      name.title = "Work on " + trk.name;
      const icon = document.createElement("span");
      icon.className = "studio-track-icon";
      icon.textContent = KINDS[trk.type].icon;
      const title = document.createElement("span");
      title.className = "studio-track-title";
      title.textContent = trk.name;
      const kind = document.createElement("span");
      kind.className = "studio-track-kind";
      kind.textContent = kindLabel(trk);
      name.append(icon, title, kind);
      name.addEventListener("click", () => { if (!learning) setActive(trk.id); });
      const mute = document.createElement("button");
      mute.type = "button";
      mute.className = "studio-mix-mute";
      mute.textContent = "M";
      mute.dataset.target = "mute:" + trk.id;
      mute.setAttribute("aria-label", "Mute " + trk.name);
      mute.addEventListener("click", () => { if (!learning) toggleMute(trk.id); });
      const solo = document.createElement("button");
      solo.type = "button";
      solo.className = "studio-mix-solo";
      solo.textContent = "S";
      solo.dataset.target = "solo:" + trk.id;
      solo.setAttribute("aria-label", "Solo " + trk.name);
      solo.addEventListener("click", () => { if (!learning) toggleSolo(trk.id); });
      const vol = document.createElement("input");
      vol.type = "range";
      vol.min = 0;
      vol.max = 100;
      vol.className = "studio-track-vol";
      vol.dataset.target = "vol:" + trk.id;
      vol.setAttribute("aria-label", trk.name + " volume");
      vol.addEventListener("input", () => setVol(trk.id, vol.value / 100));
      const pan = document.createElement("input");
      pan.type = "range";
      pan.min = -100;
      pan.max = 100;
      pan.className = "studio-track-pan";
      pan.dataset.target = "pan:" + trk.id;
      pan.setAttribute("aria-label", trk.name + " pan");
      pan.addEventListener("input", () => setPan(trk.id, pan.value / 100));
      pan.addEventListener("dblclick", () => setPan(trk.id, 0));
      row.append(name, mute, solo, vol, pan);
      trackList.appendChild(row);
      trackEls[trk.id] = { row, title, kind, mute, solo, vol, pan };
      syncMixerUi(trk.id);
    });
  }

  function refreshTrackLabels() {
    S.tracks.forEach((t) => {
      const els = trackEls[t.id];
      if (!els) return;
      els.title.textContent = t.name;
      els.kind.textContent = kindLabel(t);
      els.row.classList.toggle("is-active", t.id === S.active);
    });
  }

  function setTrackInst(trk, name) {
    if (!trk || !isNoteKind(trk) || !INST_NAMES[name]) return;
    trk.inst = name;
    if (trk.id === (noteTrack() || {}).id) { K.setInstrument(name); instSelect.value = name; }
    refreshTrackLabels();
    save();
  }

  // the Sound menu above the keys sets the sound of the track you are working on
  instSelect.addEventListener("change", () => {
    const trk = noteTrack();
    if (trk && trk.type !== "sampler") { trk.inst = instSelect.value; renderSettings(); refreshTrackLabels(); save(); }
  });

  function setActive(id, keepTab) {
    const trk = trackById(id);
    if (!trk) return;
    S.active = id;
    if (trk.type === "drums") lastDrumId = id;
    if (isNoteKind(trk)) lastNoteId = id;
    select(null);
    audioSel = null;
    const nt = noteTrack();
    if (nt && nt.type !== "sampler") { K.setInstrument(nt.inst); instSelect.value = nt.inst; }
    try { localStorage.setItem(STORE_KEY + "-active", id); } catch (error) { /* fine */ }
    refreshTrackLabels();
    renderSettings();
    paint();
    if (!keepTab) showTab(trk.type === "drums" ? "seq" : "roll");
    else updateRollMode();
    dirty = true;
  }

  function addTrack(type) {
    if (!KINDS[type]) return;
    const trk = newTrack(type);
    S.tracks.push(trk);
    if (live) ensureChannels(live);
    registerTargets();
    renderTracks();
    renderMixer();
    setActive(trk.id);
    save();
  }

  function removeTrack(id) {
    const trk = trackById(id);
    if (!trk || trk.builtin) return;
    if (mic && mic.trk === trk) finishAudioRecording();
    S.tracks = S.tracks.filter((t) => t !== trk);
    delete S.mixer[id];
    if (live && live.ch[id]) live.ch[id].input.gain.value = 0;
    killSources();
    if (!S.tracks.some(isNoteKind)) S.tracks.push(newTrack("inst", "Keys"));
    if (lastDrumId === id) lastDrumId = "drums";
    if (lastNoteId === id) lastNoteId = (S.tracks.find(isNoteKind) || {}).id || "";
    registerTargets();
    renderTracks();
    renderMixer();
    setActive(S.active === id ? (S.tracks.find(isNoteKind) || S.tracks[0]).id : S.active, true);
    save();
  }

  document.querySelectorAll(".studio-add-track-button").forEach((b) => b.addEventListener("click", () => addTrack(b.dataset.type)));
  const importInput = $("studio-import-audio");
  if (importInput) {
    $("studio-import-button").addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", () => {
      const files = Array.from(importInput.files || []);
      importInput.value = "";
      if (files.length) importAudioFiles(files);
    });
  }

  // ---------- the settings for the track you are working on ----------
  function field(label, control) {
    const wrap = document.createElement("label");
    wrap.className = "studio-preset-label studio-setting";
    const span = document.createElement("span");
    span.textContent = label;
    wrap.append(span, control);
    return wrap;
  }

  function sliderField(label, min, max, step, value, fmt, onInput) {
    const wrap = document.createElement("label");
    wrap.className = "studio-note-editor-slider studio-setting";
    const span = document.createElement("span");
    const out = document.createElement("output");
    out.textContent = fmt(value);
    span.append(label + " ", out);
    const input = document.createElement("input");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.addEventListener("input", () => { out.textContent = fmt(Number(input.value)); onInput(Number(input.value)); });
    wrap.append(span, input);
    return wrap;
  }

  function smallButton(text, onClick, id) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "studio-small-button";
    b.textContent = text;
    if (id) b.id = id;
    b.addEventListener("click", onClick);
    return b;
  }

  function fileField(label, accept, onFile) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => { if (input.files && input.files[0]) onFile(input.files[0]); input.value = ""; });
    return field(label, input);
  }

  const noteName = (m) => K.noteName(m);
  const stripExt = (n) => n.replace(/\.[a-z0-9]{2,5}$/i, "").slice(0, 40) || "sample";

  async function loadSampleFile(file, trk) {
    if (file.size > 25 * 1048576) { setSettingsNote("That file is over 25 MB. Try a shorter one."); return; }
    try {
      setSettingsNote("Loading…");
      const id = await storeAudio(file);
      trk.sample = { id, name: stripExt(file.name), root: trk.sample ? trk.sample.root : 60, whole: trk.sample ? trk.sample.whole : true };
      refreshTrackLabels();
      renderSettings();
      dirty = true;
      save();
    } catch (error) { setSettingsNote("Could not read that file. Try a WAV, MP3 or OGG."); }
  }

  async function importClip(file, trk) {
    if (file.size > 25 * 1048576) { setSettingsNote("That file is over 25 MB. Try a shorter one."); return; }
    try {
      setSettingsNote("Loading…");
      const id = await storeAudio(file);
      const at = playing || paused ? Math.round(position()) : 0;
      const clip = { id, bufferId: id, name: stripExt(file.name), start: at, gain: 1 };
      trk.clips.push(clip);
      audioSel = clip;
      refreshTrackLabels();
      renderSettings();
      dirty = true;
      save();
    } catch (error) { setSettingsNote("Could not read that file. Try a WAV, MP3 or OGG."); }
  }

  // "Import audio": every file becomes its own Voice / Audio track, and the loop grows to fit it
  async function importAudioFiles(files) {
    for (const file of files) {
      addTrack("audio");
      const trk = S.tracks[S.tracks.length - 1];
      trk.name = stripExt(file.name).slice(0, 24) || trk.name;
      await importClip(file, trk);
      const clip = trk.clips[trk.clips.length - 1];
      const buf = clip && audio.buffers[clip.bufferId];
      if (buf) {
        const bars = Math.ceil(buf.duration / stepLength() / STEPS);
        const fit = [1, 2, 4, 8, 16].find((b) => b >= bars) || 16;
        if (fit > S.bars) setBars(fit);
      }
      renderTracks();
      dirty = true;
      save();
    }
  }

  function setSettingsNote(text) {
    const n = $("studio-settings-note");
    if (n) n.textContent = text;
  }

  function renderSettings() {
    settingsBox.textContent = "";
    const trk = activeTrack();
    if (!trk) return;
    const m = S.mixer[trk.id] || freshMix();
    const row = document.createElement("div");
    row.className = "studio-settings-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 30;
    nameInput.value = trk.name;
    nameInput.className = "studio-name-input";
    nameInput.disabled = trk.builtin;
    nameInput.addEventListener("input", () => { trk.name = nameInput.value.slice(0, 30) || KINDS[trk.type].label; refreshTrackLabels(); save(); });
    row.appendChild(field("Name", nameInput));

    if (trk.type === "inst" || trk.type === "bass" || trk.type === "guitar") {
      const sound = document.createElement("select");
      sound.innerHTML = instSelect.innerHTML;
      sound.value = trk.inst;
      sound.addEventListener("change", () => setTrackInst(trk, sound.value));
      row.appendChild(field("Sound", sound));
      row.appendChild(sliderField("Release", 0, 4, 0.1, trk.release || 0, (v) => v.toFixed(1) + " s", (v) => { trk.release = v; save(); }));
    } else if (trk.type === "sampler") {
      row.appendChild(fileField("Load a sound", "audio/*", (f) => loadSampleFile(f, trk)));
      row.appendChild(smallButton(mic && mic.trk === trk && mic.purpose === "sample" ? "■ Stop" : "● Record a sample", () => (mic ? finishAudioRecording() : startMic("sample", trk))));
      const root = document.createElement("select");
      for (let n = 24; n <= 96; n++) root.add(new Option(noteName(n), String(n)));
      root.value = String(trk.sample ? trk.sample.root : 60);
      root.disabled = !trk.sample;
      root.addEventListener("change", () => { if (trk.sample) { trk.sample.root = Number(root.value); dirty = true; save(); } });
      row.appendChild(field("Plays at its own pitch on", root));
      const whole = document.createElement("input");
      whole.type = "checkbox";
      whole.checked = trk.sample ? trk.sample.whole !== false : true;
      whole.disabled = !trk.sample;
      whole.addEventListener("change", () => { if (trk.sample) { trk.sample.whole = whole.checked; save(); } });
      const wholeLabel = document.createElement("label");
      wholeLabel.className = "studio-check-label";
      wholeLabel.append(whole, " Play the whole sound");
      row.appendChild(wholeLabel);
      const buffer = trk.sample && audio.buffers[trk.sample.id];
      const info = document.createElement("p");
      info.className = "studio-settings-info";
      info.textContent = trk.sample ? (buffer ? trk.sample.name + " · " + buffer.duration.toFixed(2) + " s" : "Loading " + trk.sample.name + "…") : "Load a WAV, MP3 or OGG file, or record one. Then write notes on the Piano roll: higher notes play it higher.";
      row.appendChild(info);
    } else if (trk.type === "audio") {
      const recording = mic && mic.trk === trk && mic.purpose === "clip";
      const rec = smallButton(recording ? "■ Stop recording" : "● Record from the microphone", () => (mic ? finishAudioRecording() : startMic("clip", trk)));
      rec.classList.toggle("is-recording", !!recording);
      row.appendChild(rec);
      row.appendChild(fileField("Add a file", "audio/*", (f) => importClip(f, trk)));
      const info = document.createElement("p");
      info.className = "studio-settings-info";
      info.textContent = "Recording starts at the playhead and plays along with the loop. Use headphones, so the mic does not hear the speakers. Open the Piano roll tab to see and move your clips.";
      row.appendChild(info);
    } else {
      const info = document.createElement("p");
      info.className = "studio-settings-info";
      info.textContent = trk.builtin
        ? "Edit its pattern on the Sequencer tab, or play the pads. The eight drum voices also have their own faders on the Mixer."
        : "A second drum machine with its own pattern and its own volume, pan and effects. Edit it on the Sequencer tab.";
      row.appendChild(info);
    }
    settingsBox.appendChild(row);

    const fx = document.createElement("div");
    fx.className = "studio-settings-row studio-settings-fx";
    const pct = (v) => Math.round(v * 100) + "%";
    fx.appendChild(sliderField("Reverb", 0, 1, 0.05, m.rev || 0, pct, (v) => setFx(trk.id, "rev", v)));
    fx.appendChild(sliderField("Echo", 0, 1, 0.05, m.del || 0, pct, (v) => setFx(trk.id, "del", v)));
    fx.appendChild(sliderField("Drive", 0, 1, 0.05, m.drive || 0, pct, (v) => setFx(trk.id, "drive", v)));
    fx.appendChild(sliderField("Tone", 0, 1, 0.05, m.tone === undefined ? 1 : m.tone, (v) => (v >= 0.98 ? "open" : pct(v)), (v) => setFx(trk.id, "tone", v)));
    if (!trk.builtin) fx.appendChild(smallButton("Remove track", () => removeTrack(trk.id), "studio-track-remove"));
    settingsBox.appendChild(fx);
    const note = document.createElement("p");
    note.className = "studio-settings-info";
    note.id = "studio-settings-note";
    note.setAttribute("role", "status");
    settingsBox.appendChild(note);
  }

  // ---------- recording from the microphone ----------
  let mic = null; // { stream, rec, chunks, purpose: "clip" | "sample", trk, startStep }

  async function startMic(purpose, trk) {
    if (mic) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      setSettingsNote("This browser cannot record. Try Chrome, Edge or Firefox.");
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (error) {
      setSettingsNote("The microphone is blocked. Allow it in the address bar and try again.");
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    const session = { stream, rec, chunks, purpose, trk, startStep: 0 };
    rec.onstop = () => finishMic(session, new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    mic = session;
    if (purpose === "clip") {
      if (!playing) start(paused ? resumeStep : 0);
      session.startStep = position();
    }
    rec.start();
    renderSettings();
    setSettingsNote(purpose === "clip" ? "Recording… press Stop (or Space) when you are done." : "Recording a sample… press Stop when you are done.");
  }

  function finishAudioRecording() {
    if (mic && mic.rec.state !== "inactive") mic.rec.stop();
  }

  async function finishMic(session, blob) {
    session.stream.getTracks().forEach((t) => t.stop());
    if (mic === session) mic = null;
    if (!blob.size || !trackById(session.trk.id)) { renderSettings(); return; }
    try {
      const id = await storeAudio(blob);
      if (session.purpose === "sample") {
        session.trk.sample = { id, name: "My recording", root: 60, whole: true };
      } else {
        const clip = { id, bufferId: id, name: "Take " + (session.trk.clips.length + 1), start: session.startStep, gain: 1 };
        session.trk.clips.push(clip);
        audioSel = clip;
      }
      refreshTrackLabels();
      dirty = true;
      save();
    } catch (error) { setSettingsNote("Could not use that recording."); }
    renderSettings();
  }

  // ---------- the audio lane: clips on a timeline ----------
  const audioPanel = $("studio-audio-panel");
  const lane = $("studio-audio-lane");
  const laneCtx = lane.getContext("2d");
  const LANE_H = 150;
  let audioSel = null;

  function sizeLane() {
    const w = LABEL_W + stepW * totalSteps();
    const dpr = window.devicePixelRatio || 1;
    lane.style.width = w + "px";
    lane.style.height = LANE_H + "px";
    lane.width = Math.round(w * dpr);
    lane.height = Math.round(LANE_H * dpr);
    laneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  function clipRect(c) {
    const b = audio.buffers[c.bufferId];
    const steps = b ? b.duration / stepLength() : 4;
    return { x: LABEL_W + c.start * stepW, w: Math.max(6, steps * stepW), steps };
  }

  function drawLane() {
    const trk = activeTrack();
    if (!trk || trk.type !== "audio") return;
    const w = LABEL_W + stepW * totalSteps();
    const light = document.documentElement.dataset.theme === "light";
    laneCtx.clearRect(0, 0, w, LANE_H);
    laneCtx.fillStyle = light ? "rgba(80,10,12,0.05)" : "rgba(255,238,238,0.04)";
    laneCtx.fillRect(LABEL_W, HEAD, w - LABEL_W, LANE_H - HEAD);
    for (let s = 0; s <= totalSteps(); s++) {
      const x = LABEL_W + s * stepW + 0.5;
      laneCtx.strokeStyle = s % STEPS === 0 ? (light ? "rgba(80,10,12,0.6)" : "rgba(255,238,238,0.5)")
        : s % 4 === 0 ? (light ? "rgba(80,10,12,0.3)" : "rgba(255,238,238,0.2)") : (light ? "rgba(80,10,12,0.08)" : "rgba(255,238,238,0.06)");
      laneCtx.beginPath();
      laneCtx.moveTo(x, s % 4 === 0 ? HEAD - 7 : HEAD);
      laneCtx.lineTo(x, LANE_H);
      laneCtx.stroke();
    }
    laneCtx.fillStyle = light ? "#5a1a1f" : "#cdbdbd";
    laneCtx.font = "600 10px sans-serif";
    laneCtx.textBaseline = "middle";
    laneCtx.fillText("Bar", 8, HEAD / 2);
    for (let s = 0; s < totalSteps(); s += STEPS) laneCtx.fillText(String(s / STEPS + 1), LABEL_W + s * stepW + 4, HEAD / 2);
    laneCtx.fillText(trk.name, 8, HEAD + 14);
    trk.clips.forEach((c) => {
      const r = clipRect(c);
      const top = HEAD + 8, h = LANE_H - HEAD - 16;
      laneCtx.fillStyle = c === audioSel ? "rgba(90,200,170,0.5)" : "rgba(90,200,170,0.3)";
      laneCtx.fillRect(r.x, top, r.w, h);
      const peaks = audio.peaks[c.bufferId];
      if (peaks) {
        laneCtx.fillStyle = "rgba(160,255,230,0.9)";
        const cols = Math.max(1, Math.floor(r.w / 2));
        for (let i = 0; i < cols; i++) {
          const v = peaks[Math.min(peaks.length - 1, Math.floor((i / cols) * peaks.length))] * (c.gain === undefined ? 1 : c.gain);
          const half = Math.min(h / 2, v * (h / 2));
          laneCtx.fillRect(r.x + i * 2, top + h / 2 - half, 1.4, Math.max(1, half * 2));
        }
      }
      laneCtx.strokeStyle = c === audioSel ? "#fff" : "rgba(90,200,170,0.9)";
      laneCtx.lineWidth = c === audioSel ? 2 : 1;
      laneCtx.strokeRect(r.x + 0.5, top + 0.5, r.w - 1, h - 1);
      laneCtx.lineWidth = 1;
      laneCtx.fillStyle = light ? "#0a2a22" : "#e8fff8";
      laneCtx.fillText(c.name, r.x + 6, top + 10);
    });
    if (!trk.clips.length) {
      laneCtx.fillStyle = light ? "#5a1a1f" : "#cdbdbd";
      laneCtx.fillText("No clips yet. Record from the microphone or add a file in the track settings above.", LABEL_W + 14, HEAD + (LANE_H - HEAD) / 2);
    }
    if (playing || paused) {
      const x = LABEL_W + position() * stepW;
      laneCtx.fillStyle = "#ff3b3b";
      laneCtx.fillRect(x - 1, 0, 2, LANE_H);
    }
    const gain = $("studio-clip-gain");
    if (gain && document.activeElement !== gain) gain.value = String(Math.round(((audioSel && audioSel.gain !== undefined ? audioSel.gain : 1)) * 100));
    $("studio-clip-remove").disabled = !audioSel;
    gain.disabled = !audioSel;
  }

  function lanePoint(event) {
    const rect = lane.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    return { x, y, step: (x - LABEL_W) / stepW };
  }

  lane.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const trk = activeTrack();
    if (!trk || trk.type !== "audio") return;
    const p = lanePoint(event);
    lane.setPointerCapture(event.pointerId);
    if (p.y < HEAD) { if (p.x >= LABEL_W) { audioDrag = { mode: "seek" }; seek(p.step); } return; }
    const hit = [...trk.clips].reverse().find((c) => { const r = clipRect(c); return p.x >= r.x && p.x <= r.x + r.w; });
    audioSel = hit || null;
    audioDrag = hit ? { mode: "move", clip: hit, grab: p.step - hit.start } : null;
    dirty = true;
  });
  let audioDrag = null;
  lane.addEventListener("pointermove", (event) => {
    if (!audioDrag) return;
    const p = lanePoint(event);
    if (audioDrag.mode === "seek") { seek(clamp(p.step, 0, totalSteps() - 1)); return; }
    audioDrag.clip.start = Math.max(0, Math.round((p.step - audioDrag.grab) * 4) / 4);
    dirty = true;
  });
  const endLaneDrag = () => { if (audioDrag && audioDrag.mode === "move") save(); audioDrag = null; };
  lane.addEventListener("pointerup", endLaneDrag);
  lane.addEventListener("pointercancel", endLaneDrag);
  $("studio-clip-remove").addEventListener("click", () => {
    const trk = activeTrack();
    if (!trk || !audioSel) return;
    trk.clips = trk.clips.filter((c) => c !== audioSel);
    audioSel = null;
    killSources();
    refreshTrackLabels();
    dirty = true;
    save();
  });
  $("studio-clip-gain").addEventListener("input", () => {
    if (audioSel) { audioSel.gain = Number($("studio-clip-gain").value) / 100; dirty = true; save(); }
  });
  document.addEventListener("keydown", (event) => {
    if (tab !== "roll" || !audioSel || (activeTrack() || {}).type !== "audio") return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
    event.preventDefault();
    $("studio-clip-remove").click();
  });

  // the roll tab shows notes for most tracks and the clip lane for an audio track
  function updateRollMode() {
    const audioMode = (activeTrack() || {}).type === "audio";
    $("studio-roll-notes").hidden = audioMode;
    audioPanel.hidden = !audioMode;
    if (tab === "roll") { sizeRoll(); sizeLane(); }
  }

  // ---------- the mixer ----------
  const mixer = $("studio-mixer");

  function makeStrip(id, name, isMaster) {
    const strip = document.createElement("div");
    strip.className = "studio-mix-strip" + (isMaster ? " studio-mix-master" : "");
    const meter = document.createElement("div");
    meter.className = "studio-mix-meter";
    const fill = document.createElement("span");
    fill.className = "studio-mix-meter-fill";
    meter.appendChild(fill);
    const faderBox = document.createElement("div");
    faderBox.className = "studio-mix-fader-box";
    const fader = document.createElement("input");
    fader.type = "range";
    fader.min = 0;
    fader.max = 100;
    fader.className = "studio-mix-fader";
    fader.dataset.target = (isMaster ? "master" : "vol:" + id);
    fader.setAttribute("aria-label", name + " volume");
    fader.addEventListener("input", () => setVol(id, fader.value / 100));
    faderBox.appendChild(fader);
    const els = { fader, fill };
    strip.append(meter, faderBox);
    if (!isMaster) {
      const pan = document.createElement("input");
      pan.type = "range";
      pan.min = -100;
      pan.max = 100;
      pan.className = "studio-mix-pan";
      pan.dataset.target = "pan:" + id;
      pan.setAttribute("aria-label", name + " pan");
      pan.addEventListener("input", () => setPan(id, pan.value / 100));
      pan.addEventListener("dblclick", () => setPan(id, 0));
      const buttons = document.createElement("div");
      buttons.className = "studio-mix-buttons";
      const mute = document.createElement("button");
      mute.type = "button";
      mute.className = "studio-mix-mute";
      mute.textContent = "M";
      mute.dataset.target = "mute:" + id;
      mute.setAttribute("aria-label", "Mute " + name);
      mute.addEventListener("click", () => { if (!learning) toggleMute(id); });
      const solo = document.createElement("button");
      solo.type = "button";
      solo.className = "studio-mix-solo";
      solo.textContent = "S";
      solo.dataset.target = "solo:" + id;
      solo.setAttribute("aria-label", "Solo " + name);
      solo.addEventListener("click", () => { if (!learning) toggleSolo(id); });
      buttons.append(mute, solo);
      strip.append(pan, buttons);
      els.pan = pan;
      els.mute = mute;
      els.solo = solo;
    }
    const label = document.createElement("span");
    label.className = "studio-mix-name";
    label.textContent = name;
    strip.appendChild(label);
    mixer.appendChild(strip);
    els.label = label;
    mixerEls[id] = els;
  }

  function renderMixer() {
    mixer.textContent = "";
    Object.keys(mixerEls).forEach((k) => delete mixerEls[k]);
    TRACK_IDS.forEach((id) => makeStrip(id, NAME[id], false));
    S.tracks.forEach((t) => makeStrip(t.id, t.builtin ? "Drums" : t.name, false));
    makeStrip("master", "Master", true);
    channels().forEach(syncMixerUi);
    syncMixerUi("master");
  }

  const meterBuf = new Float32Array(512);
  const levels = {};
  function drawMeters() {
    if (!live) return;
    Object.keys(mixerEls).forEach((id) => {
      const analyser = id === "master" ? live.masterAnalyser : (live.ch[id] && live.ch[id].analyser);
      if (!analyser) return;
      analyser.getFloatTimeDomainData(meterBuf);
      let peak = 0;
      for (let i = 0; i < meterBuf.length; i++) peak = Math.max(peak, Math.abs(meterBuf[i]));
      levels[id] = Math.max(peak, (levels[id] || 0) * 0.9);
      mixerEls[id].fill.style.width = Math.min(100, Math.sqrt(levels[id]) * 100) + "%";
    });
  }

  // ---------- tabs ----------
  let tab = "seq";
  function showTab(name) {
    tab = name;
    document.querySelectorAll(".studio-tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    ["seq", "roll", "mix"].forEach((t) => { $("studio-panel-" + t).hidden = t !== name; });
    if (name === "roll") updateRollMode();
    dirty = true;
  }
  document.querySelectorAll(".studio-tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  window.addEventListener("resize", () => { sizeProgress(); if (tab === "roll") { sizeRoll(); sizeLane(); } });

  // ---------- the progress bar: time, bars, and a strip you can click or drag to jump ----------
  const prog = $("studio-progress");
  const progCanvas = $("studio-progress-canvas");
  const progCtx = progCanvas.getContext("2d");
  const PROG_H = 44;
  let progDrag = false;

  function sizeProgress() {
    const w = Math.max(200, prog.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    progCanvas.style.width = w + "px";
    progCanvas.style.height = PROG_H + "px";
    progCanvas.width = Math.round(w * dpr);
    progCanvas.height = Math.round(PROG_H * dpr);
    progCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  const clockText = (seconds) => {
    const s = Math.max(0, seconds);
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + (s % 60).toFixed(1).padStart(4, "0");
  };

  function drawProgress() {
    const w = Math.max(200, prog.clientWidth);
    const light = document.documentElement.dataset.theme === "light";
    const total = totalSteps();
    const pos = playing || paused ? position() : 0;
    const x = (pos / total) * (w - 2) + 1;
    progCtx.clearRect(0, 0, w, PROG_H);
    progCtx.fillStyle = light ? "rgba(80,10,12,0.08)" : "rgba(255,238,238,0.07)";
    progCtx.fillRect(0, 14, w, PROG_H - 14);
    progCtx.fillStyle = light ? "rgba(190,20,30,0.3)" : "rgba(255,59,59,0.3)";
    progCtx.fillRect(0, 14, x, PROG_H - 14);
    progCtx.font = "600 10px sans-serif";
    progCtx.textBaseline = "top";
    for (let s = 0; s < total; s += 4) {
      const tx = (s / total) * (w - 2) + 1.5;
      const barLine = s % STEPS === 0;
      progCtx.strokeStyle = light ? "rgba(80,10,12,0.45)" : "rgba(255,238,238,0.4)";
      progCtx.beginPath();
      progCtx.moveTo(tx, barLine ? 3 : 20);
      progCtx.lineTo(tx, PROG_H);
      progCtx.stroke();
      if (barLine && (total <= 64 || (s / STEPS) % 2 === 0)) {
        progCtx.fillStyle = light ? "#5a1a1f" : "#cdbdbd";
        progCtx.fillText(String(s / STEPS + 1), tx + 3, 2);
      }
    }
    progCtx.fillStyle = "#ff3b3b";
    progCtx.fillRect(x - 1, 8, 2, PROG_H - 8);
    progCtx.beginPath();
    progCtx.moveTo(x - 6, 6);
    progCtx.lineTo(x + 6, 6);
    progCtx.lineTo(x, 15);
    progCtx.closePath();
    progCtx.fill();
    $("studio-time").textContent = clockText(pos * stepLength()) + " / " + clockText(total * stepLength());
    $("studio-barpos").textContent = "Bar " + (Math.floor(pos / STEPS) + 1) + " · Beat " + (Math.floor((pos % STEPS) / 4) + 1);
    prog.setAttribute("aria-valuenow", String(Math.round((pos / total) * 100)));
  }

  function progStep(event) {
    const rect = prog.getBoundingClientRect();
    return clamp(((event.clientX - rect.left) / rect.width) * totalSteps(), 0, totalSteps() - 1);
  }
  prog.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || learning) return;
    prog.setPointerCapture(event.pointerId);
    progDrag = true;
    seek(progStep(event));
  });
  prog.addEventListener("pointermove", (event) => { if (progDrag) seek(progStep(event)); });
  ["pointerup", "pointercancel"].forEach((n) => prog.addEventListener(n, () => { progDrag = false; }));
  prog.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      seek(position() + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? STEPS : 4));
    }
  });

  // ---------- export a WAV (and a zip of stems) ----------
  function encodeWav(buffer) {
    const channelsCount = buffer.numberOfChannels;
    const frames = buffer.length;
    const bytes = 44 + frames * channelsCount * 2;
    const view = new DataView(new ArrayBuffer(bytes));
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    text(0, "RIFF");
    view.setUint32(4, bytes - 8, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelsCount, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channelsCount * 2, true);
    view.setUint16(32, channelsCount * 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, frames * channelsCount * 2, true);
    const data = [];
    for (let c = 0; c < channelsCount; c++) data.push(buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channelsCount; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([view], { type: "audio/wav" });
  }

  // Renders anything offline through the same compressor the live output has.
  // build(ctx, out) schedules the sounds; the result is a stereo AudioBuffer.
  async function renderBuffer(seconds, build) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) throw new Error("This browser cannot render audio offline.");
    const rate = 44100;
    const ctx = new Offline(2, Math.ceil(seconds * rate), rate);
    const out = ctx.createDynamicsCompressor();
    out.threshold.value = -12;
    out.knee.value = 24;
    out.ratio.value = 3;
    out.attack.value = 0.01;
    out.release.value = 0.25;
    out.connect(ctx.destination);
    build(ctx, out);
    return ctx.startRendering();
  }

  function download(blob, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  }

  // Sound-effect mode: cut the silence off both ends, set the loudness, and fade the last few milliseconds.
  function finishSfx(buf) {
    const rate = buf.sampleRate;
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    let first = buf.length;
    let last = 0;
    for (let i = 0; i < buf.length; i++) {
      for (let c = 0; c < chans.length; c++) {
        if (Math.abs(chans[c][i]) > 0.002) { if (i < first) first = i; last = i; }
      }
    }
    if (last <= first) return buf;
    const from = Math.max(0, first - Math.round(rate * 0.01));
    const to = Math.min(buf.length, last + Math.round(rate * 0.05));
    let peak = 0;
    for (let c = 0; c < chans.length; c++) for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(chans[c][i]));
    const k = peak > 0 ? 0.89 / peak : 1;
    const fade = Math.round(rate * 0.025);
    const out = chans.map((d) => {
      const o = new Float32Array(to - from);
      for (let i = 0; i < o.length; i++) {
        const tail = o.length - i;
        o[i] = d[from + i] * k * (tail < fade ? tail / fade : 1);
      }
      return o;
    });
    return { numberOfChannels: out.length, length: to - from, sampleRate: rate, getChannelData: (c) => out[c] };
  }

  // One pass through the whole song as it is set now (mixer, mutes, solos and effects included).
  function renderSong() {
    const sfx = S.sfx;
    const total = totalSteps();
    const repeats = sfx ? 1 : Math.max(1, Math.round(4 / S.bars)); // a loop is played to fill four bars
    const sl = stepLength();
    const fxOn = (key) => channels().some((id) => (S.mixer[id][key] || 0) > 0.01);
    const tail = (sfx ? 3 : 1.5) + (fxOn("rev") ? 2 : 0) + (fxOn("del") ? 1.5 : 0); // a tail so the last notes and echoes can ring out
    const seconds = total * repeats * sl + tail;
    return renderBuffer(seconds, (ctx, out) => {
      const e = buildEngine(ctx, out, false);
      for (let s = 0; s < total * repeats; s++) scheduleStepInto(e, s % total, 0.05 + s * sl, sl);
    });
  }

  async function exportWav() {
    exportButton.disabled = true;
    exportNote.textContent = S.sfx ? "Rendering your sound effect…" : "Rendering your loop…";
    try {
      const sfx = S.sfx;
      let rendered = await renderSong();
      if (sfx) rendered = finishSfx(rendered);
      const blob = encodeWav(rendered);
      const file = sfx ? "tcsmusic-sfx.wav" : "tcsmusic-loop.wav";
      download(blob, file);
      exportNote.textContent = "Saved " + file + " (" + (blob.size / 1048576).toFixed(2) + " MB, " + (rendered.length / rendered.sampleRate).toFixed(2) + " seconds" + (sfx ? ", trimmed and level-matched" : "") + ").";
    } catch (error) {
      exportNote.textContent = "Could not export: " + error.message;
    }
    exportButton.disabled = false;
  }

  // a zip with no compression: each stem is a WAV, so there is little to squeeze anyway
  const crcTable = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name);
      const crc = crc32(f.bytes);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(10, 0, true);
      local.setUint16(12, 0x0021, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, f.bytes.length, true);
      local.setUint32(22, f.bytes.length, true);
      local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, f.bytes);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(14, 0x0021, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, f.bytes.length, true);
      cen.setUint32(24, f.bytes.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen.buffer, name);
      offset += 30 + name.length + f.bytes.length;
    });
    const size = central.reduce((n, p) => n + (p.byteLength !== undefined ? p.byteLength : p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  const hasContent = (t) => (t.type === "drums" ? TRACK_IDS.some((id) => t.pattern[id].some(Boolean))
    : t.type === "audio" ? t.clips.length > 0 : t.type === "sampler" ? t.notes.length > 0 && !!t.sample : t.notes.length > 0);

  // Every track on its own, lined up and the same length, ready to drop into other software.
  async function exportStems() {
    const wanted = S.tracks.filter((t) => hasContent(t) && !S.mixer[t.id].mute);
    if (!wanted.length) { exportNote.textContent = "Nothing to export yet: add some notes, beats or clips first."; return; }
    const stemsButton = $("studio-stems");
    stemsButton.disabled = true;
    const solos = {};
    channels().forEach((id) => { solos[id] = S.mixer[id].solo; });
    const files = [];
    try {
      for (let i = 0; i < wanted.length; i++) {
        exportNote.textContent = "Rendering stem " + (i + 1) + " of " + wanted.length + "…";
        channels().forEach((id) => { S.mixer[id].solo = false; });
        S.mixer[wanted[i].id].solo = true;
        const rendered = await renderSong();
        const blob = encodeWav(rendered);
        const slug = (wanted[i].builtin ? "drums" : wanted[i].name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "track";
        files.push({ name: String(i + 1).padStart(2, "0") + "-" + slug + ".wav", bytes: new Uint8Array(await blob.arrayBuffer()) });
      }
      const zip = makeZip(files);
      download(zip, "tcsmusic-stems.zip");
      exportNote.textContent = "Saved tcsmusic-stems.zip: " + files.length + " stems, all the same length, so they line up (" + (zip.size / 1048576).toFixed(1) + " MB).";
    } catch (error) {
      exportNote.textContent = "Could not export the stems: " + error.message;
    }
    channels().forEach((id) => { S.mixer[id].solo = solos[id]; });
    stemsButton.disabled = false;
  }

  // ---------- the control targets: everything MIDI can drive ----------
  const targets = {};
  function target(id, label, group, kind, fn) { targets[id] = { id, label, group, kind, fn }; }

  const toggleRecord = () => { setRecording(!recording); if (recording && !playing) start(paused ? resumeStep : 0); };
  target("play", "Play / Stop", "Transport", "trig", () => (playing ? stop() : start()));
  target("stop", "Stop", "Transport", "trig", () => stop());
  target("record", "Record", "Transport", "trig", toggleRecord);
  target("tempo", "Tempo", "Transport", "cont", (v) => setBpm(60 + v * 240));
  target("loop", "Loop length (1/2/4/8/16 bars)", "Transport", "trig", () => setBars(S.bars === 1 ? 2 : S.bars === 2 ? 4 : S.bars === 4 ? 8 : S.bars === 8 ? 16 : 1));
  target("clear", "Clear all", "Transport", "trig", () => clearAll());
  target("undo", "Undo", "Transport", "trig", () => undo());
  target("redo", "Redo", "Transport", "trig", () => redo());
  target("octave-up", "Keyboard octave up", "Keys", "trig", () => board.shiftOctave(1));
  target("octave-down", "Keyboard octave down", "Keys", "trig", () => board.shiftOctave(-1));
  target("master", "Master volume", "Mixer", "cont", (v) => setVol("master", v));
  for (let i = 0; i < 16; i++) target("pad:" + i, "Pad " + (i + 1), "Pads", "trig", (v) => hitPad(i, v === undefined ? 0.85 : v));

  // faders, pans, mutes and solos exist for every drum voice and every track, and change as tracks come and go
  function registerTargets() {
    Object.keys(targets).forEach((id) => { if (/^(vol|pan|mute|solo):/.test(id)) delete targets[id]; });
    channels().forEach((id) => {
      const n = nameOf(id);
      target("vol:" + id, n + " volume", "Mixer", "cont", (v) => setVol(id, v));
      target("pan:" + id, n + " pan", "Mixer", "cont", (v) => setPan(id, v * 2 - 1));
      target("mute:" + id, n + " mute", "Mixer", "trig", () => toggleMute(id));
      target("solo:" + id, n + " solo", "Mixer", "trig", () => toggleSolo(id));
    });
  }

  function drive(id, value) {
    const t = targets[id];
    if (!t) return;
    t.fn(value);
  }

  // ---------- MIDI: the SMK-37 Pro and friends ----------
  let map = {};     // control key ("cc:1:21") -> target id
  let learning = false;
  let learnTarget = null;
  const lastValue = {};
  const seen = new Map();
  const learnNote = $("studio-learn-note");
  const learnButton = $("studio-learn");
  const seenBox = $("studio-midi-seen");

  try {
    const saved = JSON.parse(localStorage.getItem(MAP_KEY) || "null");
    if (saved && typeof saved === "object") {
      Object.keys(saved).forEach((key) => { if (typeof saved[key] === "string") map[key] = saved[key]; });
    }
  } catch (error) { /* keep empty */ }
  const saveMap = () => { try { localStorage.setItem(MAP_KEY, JSON.stringify(map)); } catch (error) { /* fine */ } };

  const CC_NAMES = { 1: "Mod wheel", 7: "Volume", 10: "Pan", 11: "Expression", 64: "Sustain pedal", 74: "Brightness" };
  function describe(m) {
    if (m.type === "cc") return (CC_NAMES[m.a] ? CC_NAMES[m.a] + " · " : "") + "CC " + m.a + " · ch " + m.ch;
    if (m.type === "noteon" || m.type === "noteoff") return "Note " + m.a + " (" + K.noteName(m.a) + ") · ch " + m.ch;
    if (m.type === "bend") return "Pitch wheel · ch " + m.ch;
    if (m.type === "pressure") return "Pressure · ch " + m.ch;
    if (m.type === "poly") return "Key pressure " + m.a + " · ch " + m.ch;
    return "Program " + m.a + " · ch " + m.ch;
  }

  function targetSelect(key) {
    const select = document.createElement("select");
    select.className = "main-midi-control-assign";
    select.setAttribute("aria-label", "What " + key + " controls");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Nothing";
    select.appendChild(none);
    const groups = {};
    Object.keys(targets).forEach((id) => {
      const t = targets[id];
      if (!groups[t.group]) {
        groups[t.group] = document.createElement("optgroup");
        groups[t.group].label = t.group;
        select.appendChild(groups[t.group]);
      }
      const o = document.createElement("option");
      o.value = id;
      o.textContent = t.label;
      groups[t.group].appendChild(o);
    });
    select.value = map[key] && targets[map[key]] ? map[key] : "";
    select.addEventListener("change", () => bind(key, select.value));
    return select;
  }

  function bind(key, id) {
    Object.keys(map).forEach((k) => { if (id && map[k] === id && k !== key) delete map[k]; });
    if (id) map[key] = id; else delete map[key];
    seen.forEach((row, k) => { row.select.value = map[k] && targets[map[k]] ? map[k] : ""; });
    saveMap();
  }

  function showSeen(m) {
    if (m.type === "poly" || m.type === "program") return;
    const isNote = m.type === "noteon" || m.type === "noteoff";
    if (isNote && m.ch !== 10 && !map[m.key]) return; // the keys themselves would flood the list
    let row = seen.get(m.key);
    if (!row) {
      const empty = seenBox.querySelector(".studio-midi-empty");
      if (empty) empty.remove();
      const el = document.createElement("div");
      el.className = "main-midi-control-row";
      const label = document.createElement("span");
      label.className = "main-midi-control-label";
      label.textContent = describe(m);
      const meter = document.createElement("div");
      meter.className = "main-midi-control-meter";
      const fill = document.createElement("span");
      fill.className = "main-midi-control-fill";
      meter.appendChild(fill);
      const select = targetSelect(m.key);
      el.append(label, meter, select);
      seenBox.appendChild(el);
      row = { el, fill, select };
      seen.set(m.key, row);
    }
    row.fill.style.width = (m.type === "noteoff" ? 0 : m.value * 100) + "%";
  }

  function setLearning(on) {
    learning = on;
    learnTarget = null;
    learnButton.setAttribute("aria-pressed", String(on));
    learnButton.textContent = on ? "🎯 Learn: on" : "🎯 Learn: off";
    learnNote.textContent = on ? "Click any control on this page: a slider, pad, button or fader." : "";
    document.querySelectorAll(".is-learning").forEach((el) => el.classList.remove("is-learning"));
    document.body.classList.toggle("studio-learning", on);
  }

  learnButton.addEventListener("click", () => setLearning(!learning));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && learning) setLearning(false); });
  $("studio-midi-reset").addEventListener("click", () => {
    map = {};
    saveMap();
    seen.forEach((row) => { row.select.value = ""; });
  });

  // in learn mode a click picks a control instead of using it
  document.addEventListener("pointerdown", (event) => {
    if (!learning) return;
    const el = event.target.closest("[data-target]");
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    document.querySelectorAll(".is-learning").forEach((x) => x.classList.remove("is-learning"));
    el.classList.add("is-learning");
    learnTarget = el.dataset.target;
    learnNote.textContent = "Now move or press the control on your keyboard to link it to “" + (targets[learnTarget] ? targets[learnTarget].label : learnTarget) + "”.";
  }, true);
  document.addEventListener("click", (event) => {
    if (learning && event.target.closest("[data-target]")) { event.preventDefault(); event.stopPropagation(); }
  }, true);

  const modFill = $("studio-mod-fill");
  const pitchDot = $("studio-pitch-dot");
  const lastOut = $("studio-midi-last");

  function onMidi(m) {
    lastOut.textContent = describe(m) + " · " + (m.type === "bend" ? Math.round((m.norm || 0) * 100) + "%" : m.type === "noteon" || m.type === "noteoff" ? (m.type === "noteon" ? "on " + m.b : "off") : m.b);
    showSeen(m);

    // Learn: the next real control that moves gets linked
    if (learning && learnTarget && ["noteon", "cc", "pressure", "bend"].includes(m.type)) {
      if (m.type === "cc" && m.value === lastValue[m.key]) return;
      bind(m.key, learnTarget);
      if (!seen.has(m.key)) showSeen({ ...m, ch: 10 });
      learnNote.textContent = "Linked " + describe(m) + " → " + (targets[learnTarget] ? targets[learnTarget].label : learnTarget) + ". Click another control to keep going.";
      document.querySelectorAll(".is-learning").forEach((el) => el.classList.remove("is-learning"));
      learnTarget = null;
      lastValue[m.key] = m.value;
      return;
    }

    const id = map[m.key];
    const prev = lastValue[m.key] === undefined ? 0 : lastValue[m.key];
    lastValue[m.key] = m.value;
    if (id && targets[id]) {
      const t = targets[id];
      if (m.type === "noteoff") return;
      if (t.kind === "cont") t.fn(m.value);
      else if (m.type === "noteon" || m.type === "pressure") { if (m.type === "noteon" || prev < 0.5) t.fn(m.value); }
      else if (m.value >= 0.5 && prev < 0.5) t.fn(1);
      return;
    }

    // the default wiring
    if (m.type === "noteon" && m.ch === 10) {
      drive("pad:" + (m.a >= 36 && m.a <= 51 ? m.a - 36 : m.a % 16), m.value);
    } else if (m.type === "noteon") {
      board.down(m.a, 0.03 + 0.17 * m.value);
    } else if (m.type === "noteoff") {
      if (m.ch !== 10) board.up(m.a);
    } else if (m.type === "bend") {
      K.setPitchBend(m.norm);
      pitchDot.style.left = m.value * 100 + "%";
    } else if (m.type === "cc") {
      if (m.a === 64) K.setMidiPedal(m.b < 32 ? 0 : m.b < 96 ? 0.5 : 1);
      else if (m.a === 1) { K.setVibrato(m.value); modFill.style.width = m.value * 100 + "%"; }
      else if (m.a === 7) setVol("master", m.value);
      else if (m.a === 74) K.setTone(m.value);
      else if (m.a === 123 || m.a === 120) { for (let n = 21; n <= 108; n++) board.up(n); }
    }
  }
  Hub.on(onMidi);

  const midiButton = $("studio-midi-connect");
  const midiStatus = $("studio-midi-status");
  let wasConnected = false;
  Hub.onState((s) => {
    midiButton.setAttribute("aria-pressed", String(s.connected));
    midiButton.textContent = s.connected ? "🎹 Disconnect MIDI" : "🎹 Connect MIDI";
    midiStatus.textContent = s.message || (s.connected
      ? (s.devices.length ? "Connected: " + s.devices.join(", ") : "No MIDI keyboard found. Plug one in.")
      : "Not connected");
    if (!s.connected && wasConnected) {
      K.setPitchBend(0);
      K.setVibrato(0);
      K.setTone(1);
      K.setMidiPedal(0);
      pitchDot.style.left = "50%";
      modFill.style.width = "0%";
      for (let n = 21; n <= 108; n++) board.up(n);
    }
    wasConnected = s.connected;
  });
  midiButton.addEventListener("click", () => {
    if (!Hub.status().connected) midiStatus.textContent = "Waiting for permission…";
    Hub.toggle();
  });

  // ---------- buttons ----------
  function clearAll() {
    S.tracks.forEach((t) => {
      if (t.pattern) TRACK_IDS.forEach((id) => t.pattern[id].fill(false));
      t.notes = [];
      t.pedal = [];
      t.clips = [];
    });
    killSources();
    select(null);
    audioSel = null;
    refreshTrackLabels();
    paint();
    dirty = true;
    save();
  }

  grid.addEventListener("click", (event) => {
    if (learning) return;
    const stepButton = event.target.closest(".studio-grid-step");
    if (stepButton) {
      const id = stepButton.dataset.track;
      const at = Number(stepButton.dataset.step);
      const owner = drumTrack();
      owner.pattern[id][at] = !owner.pattern[id][at];
      if (owner.pattern[id][at] && !playing) {
        const e = engine();
        hitDrum(e, id, e.ctx.currentTime, 1, owner.builtin ? null : owner.id);
      }
      paint();
      save();
      return;
    }
    const muteButton = event.target.closest(".studio-grid-mute");
    if (muteButton) toggleMute(muteButton.dataset.track);
  });

  playButton.addEventListener("click", () => { if (!learning) playPause(); });
  stopButton.addEventListener("click", () => { if (!learning) stop(); });
  recordButton.addEventListener("click", () => { if (!learning) toggleRecord(); });
  bpmInput.addEventListener("input", () => { bpmValue.textContent = bpmInput.value; if (live) applyMixer(live); drawProgress(); save(); });
  barsSelect.addEventListener("change", () => setBars(Number(barsSelect.value)));
  clearButton.addEventListener("click", clearAll);
  exportButton.addEventListener("click", exportWav);
  $("studio-stems").addEventListener("click", exportStems);
  $("studio-undo").addEventListener("click", undo);
  $("studio-redo").addEventListener("click", redo);
  const sfxBox = $("studio-sfx-mode");
  sfxBox.addEventListener("change", () => { S.sfx = sfxBox.checked; save(); });
  const metroButton = $("studio-metro");
  function setMetro(on) {
    S.metro = on;
    metroButton.setAttribute("aria-pressed", String(on));
    save();
  }
  metroButton.addEventListener("click", () => setMetro(!S.metro));

  presetSelect.addEventListener("change", () => {
    const preset = PRESETS[presetSelect.value];
    if (!preset) return;
    const pattern = drumTrack().pattern;
    TRACK_IDS.forEach((id) => {
      const row = preset[id] || "";
      for (let i = 0; i < STEPS; i++) pattern[id][i] = row.charAt(i) === "x";
    });
    presetSelect.value = "";
    paint();
    save();
  });

  // a hidden tab slows timers down, which would make the beat stumble
  document.addEventListener("visibilitychange", () => { if (document.hidden && playing) pause(); });

  // ---------- one animation loop for everything that moves ----------
  function frame() {
    if (playing) {
      const e = engine();
      while (queue.length && queue[0].time <= e.ctx.currentTime) {
        const s = queue.shift();
        curStep = s.step;
        curTime = s.time;
        showStep(s.step);
      }
    }
    if (dirty || playing) {
      drawProgress();
      if (tab === "roll") { if ((activeTrack() || {}).type === "audio") drawLane(); else drawRoll(); }
      dirty = false;
    }
    if (tab === "mix") drawMeters();
    frameId = requestAnimationFrame(frame);
  }

  // ---------- keyboard shortcuts ----------
  // Space is the play key here, as in most music software. (The sustain pedal still works from the
  // on-screen buttons, Shift and a MIDI pedal.)
  function nudge(semitones, steps) {
    const ns = [...selSet];
    if (!ns.length) return;
    if (ns.some((n) => n.midi + semitones < 21 || n.midi + semitones > 108)) semitones = 0;
    const from = Math.min(...ns.map((n) => n.start));
    const to = Math.max(...ns.map((n) => n.start + n.len));
    const ds = clamp(steps, -from, totalSteps() - to);
    ns.forEach((n) => { n.midi += semitones; n.start += ds; });
    if (semitones && sel) preview(sel.midi);
    syncEditor();
    save();
  }

  function duplicateNote() {
    const ns = [...selSet];
    const trk = noteTrack();
    if (!ns.length || !trk) return;
    const from = Math.min(...ns.map((n) => n.start));
    const to = Math.max(...ns.map((n) => n.start + n.len));
    if (to + (to - from) > totalSteps()) return;
    const copies = ns.map((n) => ({ ...n, start: n.start + (to - from) }));
    trk.notes.push(...copies);
    selectMany(copies);
    save();
  }

  const typing = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable;
  const SHORTCUT_KEYS = new Set([" ", "Enter", "Escape", "r", "e", "m", "v", "b", "q", "1", "2", "3", "[", "]", "{", "}", "?", "/", "d", "h",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]);

  window.addEventListener("keydown", (event) => {
    if (typing(event.target) || learning) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      const inRollTab = tab === "roll";
      let handled = true;
      if (key === "z") { if (event.shiftKey) redo(); else undo(); }
      else if (key === "y") redo();
      else if (inRollTab && key === "a") selectAll();
      else if (inRollTab && key === "c") copyNotes(false);
      else if (inRollTab && key === "x") copyNotes(true);
      else if (inRollTab && key === "v") pasteNotes();
      else handled = false;
      if (handled) { event.preventDefault(); event.stopPropagation(); }
      return;
    }
    if (event.altKey || (event.repeat && !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key))) return;
    const k = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (!SHORTCUT_KEYS.has(k)) return;
    const inRoll = tab === "roll";
    let done = true;
    if (k === " ") playPause();
    else if (k === "Enter") { stop(); start(0); }
    else if (k === "Escape") stop();
    else if (k === "r") toggleRecord();
    else if (k === "e") exportButton.click();
    else if (k === "m") setMetro(!S.metro);
    else if (k === "1") showTab("seq");
    else if (k === "2") showTab("roll");
    else if (k === "3") showTab("mix");
    else if (k === "[" || k === "]" || k === "{" || k === "}") setBpm(Number(bpmInput.value) + ((k === "]" || k === "}") ? 1 : -1) * (event.shiftKey || k === "{" || k === "}" ? 10 : 1));
    else if (k === "?" || k === "/") { const d = $("studio-shortcuts"); d.open = !d.open; }
    else if (inRoll && k === "v") setTool("select");
    else if (inRoll && k === "b") setTool("draw");
    else if (inRoll && k === "q") quantizeNotes();
    else if (inRoll && k === "d") { if (sel) duplicateNote(); else done = false; }
    else if (inRoll && k === "h") { if (sel) $("studio-note-hear").click(); else done = false; }
    else if (inRoll && k === "PageUp") rollShift(12);
    else if (inRoll && k === "PageDown") rollShift(-12);
    else if (inRoll && sel && k === "ArrowUp") nudge(event.shiftKey ? 12 : 1, 0);
    else if (inRoll && sel && k === "ArrowDown") nudge(event.shiftKey ? -12 : -1, 0);
    else if (inRoll && sel && k === "ArrowLeft") nudge(0, event.shiftKey ? -1 : -S.snap);
    else if (inRoll && sel && k === "ArrowRight") nudge(0, event.shiftKey ? 1 : S.snap);
    else done = false;
    if (done) { event.preventDefault(); event.stopPropagation(); }
  }, true);

  // a button that has focus would also "click" on Space or Enter: swallow that
  window.addEventListener("keyup", (event) => {
    if (event.key === " " && !typing(event.target) && !learning) { event.preventDefault(); event.stopPropagation(); }
  }, true);

  // ---------- put every control in step with the data ----------
  const sfxCheck = sfxBox;
  function rebuildUi() {
    renderTracks();
    renderMixer();
    registerTargets();
    renderSettings();
    padEls.forEach((p, i) => { p.select.value = S.pads[i]; });
    bpmValue.textContent = bpmInput.value;
    barsSelect.value = String(S.bars);
    sfxCheck.checked = S.sfx;
    metroButton.setAttribute("aria-pressed", String(S.metro));
    scaleKey.value = String(S.scale.root);
    scaleMode.value = S.scale.show && SCALES[S.scale.name] ? S.scale.name : "Off";
    $("studio-snap").value = String(S.snap);
    setTool(S.tool);
    paint();
    select(null);
    audioSel = null;
    const nt = noteTrack();
    if (nt && nt.type !== "sampler") { K.setInstrument(nt.inst); instSelect.value = nt.inst; }
    if (live) { ensureChannels(live); applyMixer(live); }
    sizeProgress();
    sizeRoll();
    sizeLane();
    updateRollMode();
    syncClipboardButtons();
    syncHistoryButtons();
    dirty = true;
  }

  load();
  rebuildUi();
  hist.stack = [JSON.stringify(serialize())];
  hist.idx = 0;
  syncHistoryButtons();

  // the Scales page sends you here with ?scale=Dorian&key=2 to shade a scale on the roll
  (function fromScalesPage() {
    try {
      const q = new URLSearchParams(location.search);
      const name = q.get("scale");
      if (!name || !SCALES[name]) return;
      const root = clamp(Number(q.get("key")) || 0, 0, 11) | 0;
      scaleKey.value = String(root);
      scaleMode.value = name;
      applyScale();
      showTab("roll");
    } catch (error) { /* no query: nothing to do */ }
  })();

  frameId = requestAnimationFrame(frame);

  // tests drive the page through this
  window.StudioApi = {
    S, K, HUES, engine, renderBuffer, encodeWav, download, noiseHit, tone, VOICES, hitDrum, playKey,
    setBpm, setBars, paint, save, sizeRoll, showTab, TRACK_IDS, select, selectMany, finishSfx, noteOpts,
    redraw: () => { dirty = true; },
    stepLength, totalSteps,
    addTrack, removeTrack, setActive, undo, redo, seek, newTrack, activeTrack, noteTrack, drumTrack,
    renderSong, makeZip, crc32, storeAudio, audio, copyNotes, pasteNotes, quantizeNotes, transposeNotes, legatoNotes,
    humanizeNotes, selectAll, pedalHold, exportStems, setTrackInst, applyState, serialize, scheduleStepInto, buildEngine,
    get selSet() { return selSet; }, get hist() { return hist; }, get clipboard() { return clipboard; },
    playClip, playSample, startMic, importAudioFiles,
  };
  window.StudioDebug = { S, targets, drive, getMap: () => map, position, get playing() { return playing; }, get paused() { return paused; } };
})();
