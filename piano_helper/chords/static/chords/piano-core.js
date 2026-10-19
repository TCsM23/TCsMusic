window.PianoKit = (function () {
  "use strict";

  const BLACK_PCS = [1, 3, 6, 8, 10];

  // ---------- sound: one master bus for everything ----------
  let audioCtx = null;
  let compressor = null;
  let master = null;
  let toneFilter = null; // the brightness control (a MIDI fader or knob can move it)
  let levelGain = null;  // the volume control
  let vibrato = null;    // a slow wobble that the mod wheel opens up
  let bendCents = 0;     // pitch wheel: -200 to +200 cents (two semitones)
  let vibratoCents = 0;  // mod wheel: 0 to 45 cents of wobble
  let toneNorm = 1;      // 0 dark to 1 bright
  let levelNorm = 1;     // 0 silent to 1 full
  const liveOscs = new Set();
  const keyboards = [];
  let mainBoard = null; // the big keyboard on the page (not the floating copy)

  function getCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.addEventListener("statechange", syncTransport);
      syncTransport();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function getBus() {
    const ctx = getCtx();
    if (!compressor) {
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -12;
      compressor.knee.value = 24;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.01;
      compressor.release.value = 0.25;
      toneFilter = ctx.createBiquadFilter();
      toneFilter.type = "lowpass";
      toneFilter.frequency.value = toneHz(toneNorm);
      levelGain = ctx.createGain();
      levelGain.gain.value = levelNorm * levelNorm;
      compressor.connect(toneFilter);
      toneFilter.connect(levelGain);
      levelGain.connect(ctx.destination);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      vibrato = ctx.createGain();
      vibrato.gain.value = vibratoCents;
      lfo.connect(vibrato);
      lfo.start();
    }
    if (!master) {
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(compressor);
    }
    return master;
  }

  function toneHz(norm) {
    return 250 * Math.pow(80, norm); // 250 Hz (dark) up to 20 kHz (bright)
  }

  // Pitch wheel, mod wheel, brightness and volume. Each takes a number from 0 to 1
  // (the pitch wheel from -1 to 1) and changes sounds that are already ringing, too.
  function setPitchBend(norm) {
    bendCents = Math.max(-1, Math.min(1, norm)) * 200;
    if (audioCtx) liveOscs.forEach((osc) => osc.detune.setTargetAtTime(bendCents, audioCtx.currentTime, 0.01));
  }
  function setVibrato(norm) {
    vibratoCents = Math.max(0, Math.min(1, norm)) * 45;
    if (vibrato) vibrato.gain.setTargetAtTime(vibratoCents, audioCtx.currentTime, 0.02);
  }
  function setTone(norm) {
    toneNorm = Math.max(0, Math.min(1, norm));
    if (toneFilter) toneFilter.frequency.setTargetAtTime(toneHz(toneNorm), audioCtx.currentTime, 0.02);
  }
  function setLevel(norm) {
    levelNorm = Math.max(0, Math.min(1, norm));
    if (levelGain) levelGain.gain.setTargetAtTime(levelNorm * levelNorm, audioCtx.currentTime, 0.02);
  }

  function noteName(midi) {
    return ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][midi % 12] + (Math.floor(midi / 12) - 1);
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // Low notes are quieter to our ears and high notes are sharper,
  // so tilt the volume by register and give low notes extra upper harmonics.
  function registerGain(midi) {
    const gain = Math.pow(2, (-0.8 * (midi - 60)) / 12);
    return Math.min(1.8, Math.max(0.45, gain));
  }
  // ---------- instruments ----------
  // partials: [wave, multiple of the pitch, level]. life: how long a ringing note lasts (seconds).
  // sustain: set it and the note holds at that level while the key is down (organ, synth).
  const PIANO_AMPS = [1, 0.5, 0.32, 0.2, 0.12, 0.08, 0.05, 0.03];
  const PIANO_PARTIALS = PIANO_AMPS.map((a, i) => ["sine", (i + 1) * Math.sqrt(1 + 0.0004 * (i + 1) * (i + 1)), a, 1 + 0.9 * i])
    .concat([0, 1, 2, 3].map((i) => ["sine", (i + 1) * Math.sqrt(1 + 0.0004 * (i + 1) * (i + 1)) * 1.0007, PIANO_AMPS[i] * 0.7, 1 + 0.9 * i]));
  // how long (seconds) the lowest partial of a piano note takes to fall by about 63%: long for bass, short for treble
  function pianoTau(midi) {
    return Math.min(5, Math.max(0.5, 2.4 * Math.pow(2, -(midi - 48) / 20)));
  }
  const INSTRUMENTS = {
    // A piano string rings with a handful of slightly stretched harmonics, and the high ones die away
    // first. A second, barely detuned copy of the lowest four gives the soft shimmer of two strings.
    piano:    { name: "Grand Piano", partials: PIANO_PARTIALS, lowBoost: true, attack: 0.012, life: 99, cutoff: 6500, trim: 0.75 },
    epiano:   { name: "Electric Piano", partials: [["sine", 1, 1], ["sine", 2, 0.3], ["sine", 4, 0.1], ["sine", 7, 0.04]], attack: 0.01, life: 4, trim: 1.6 },
    organ:    { name: "Organ", partials: [["sine", 0.5, 0.5], ["sine", 1, 1], ["sine", 2, 0.7], ["sine", 3, 0.35], ["sine", 4, 0.25]], attack: 0.015, sustain: 1, trim: 0.4 },
    synth:    { name: "Synthesizer", partials: [["sawtooth", 1, 0.5], ["sawtooth", 1.006, 0.5], ["square", 0.5, 0.3]], attack: 0.04, sustain: 0.7, cutoff: 2400, trim: 1.2 },
    harpsichord: { name: "Harpsichord", partials: [["sawtooth", 1, 0.45], ["square", 2, 0.2], ["triangle", 4, 0.15]], attack: 0.004, life: 1.3, cutoff: 5000, trim: 8 },
    musicbox: { name: "Music Box", partials: [["sine", 1, 1], ["sine", 2.76, 0.28], ["sine", 5.4, 0.1]], octave: 2, attack: 0.003, life: 2.2, trim: 1.3 },

    // ---- church sounds with a chip texture ----
    cathedral: { name: "Church Organ", partials: [["sine", 0.5, 0.6], ["sine", 1, 1], ["sine", 2, 0.8], ["sine", 3, 0.5], ["sine", 4, 0.4], ["sine", 5, 0.25], ["sine", 6, 0.2], ["sine", 8, 0.12]], attack: 0.04, sustain: 1, trim: 0.3 },
    choir:     { name: "Choir", partials: [["sawtooth", 1, 0.5], ["sawtooth", 1.005, 0.45], ["sawtooth", 0.995, 0.45], ["sine", 2, 0.25]], attack: 0.3, sustain: 0.85, cutoff: 1500, trim: 0.5 },
    strings:   { name: "Strings", partials: [["sawtooth", 1, 0.45], ["sawtooth", 1.006, 0.4], ["sawtooth", 0.994, 0.4]], attack: 0.35, sustain: 0.9, cutoff: 2600, trim: 0.45 },
    bells:     { name: "Bells", partials: [["sine", 1, 1], ["sine", 2.4, 0.5], ["sine", 3.0, 0.3], ["sine", 5.95, 0.15]], attack: 0.002, life: 3.5, trim: 1.1 },
    harp:      { name: "Harp", partials: [["triangle", 1, 1], ["sine", 2, 0.3], ["sine", 3, 0.1]], attack: 0.004, life: 2.5, trim: 1.5 },
    chiplead:  { name: "Chip Lead", partials: [["square", 1, 0.5]], attack: 0.004, sustain: 0.85, trim: 0.55 },
    chipbass:  { name: "Chip Bass", partials: [["triangle", 1, 1], ["square", 0.5, 0.25]], attack: 0.004, sustain: 0.9, trim: 1.0 },
    drone:     { name: "Dark Drone", partials: [["sawtooth", 0.5, 0.5], ["sawtooth", 0.505, 0.5], ["sine", 0.25, 0.8]], attack: 0.9, sustain: 1, cutoff: 520, trim: 0.7 },

    // ---- sound-effect sources ----
    // A pure sine: with Slide and Fade it makes thuds, heartbeats and risers.
    sine:      { name: "Pure Sine", partials: [["sine", 1, 1]], attack: 0.004, sustain: 1, trim: 1.1 },
    // Filtered noise whose centre pitch follows the note, so a Slide makes a whoosh or a sigh.
    noise:     { name: "Noise Sweep", noise: true, q: 3.5, partials: [["noise", 1, 1]], attack: 0.01, sustain: 1, trim: 2.2 },
    // A struck metal plate: inharmonic partials that ring for seconds.
    // ---- played instruments for the bass and guitar tracks ----
    // Bass: a sub sine under a filtered saw. Guitar: a plucked string (Karplus-Strong) with no samples at all.
    bass:      { name: "Bass", partials: [["sine", 1, 1], ["sawtooth", 1, 0.34], ["sawtooth", 1.004, 0.3]], attack: 0.01, sustain: 0.8, cutoff: 650, trim: 1.1 },
    guitar:    { name: "Nylon Guitar", partials: [["ks", 1, 1]], ks: 0.38, loss: 0.9992, hold: true, attack: 0.002, trim: 1.5 },
    eguitar:   { name: "Electric Guitar", partials: [["ks", 1, 1]], ks: 0.75, loss: 0.9996, hold: true, drive: 9, cutoff: 3600, attack: 0.002, trim: 0.7 },
    gong:      { name: "Gong", partials: [["sine", 1, 1], ["sine", 1.007, 0.6], ["sine", 1.47, 0.8], ["sine", 1.48, 0.45], ["sine", 2.09, 0.6], ["sine", 2.1, 0.35], ["sine", 2.56, 0.5], ["sine", 3.33, 0.35], ["sine", 4.2, 0.3]], attack: 0.003, life: 4.5, trim: 0.55 },
  };
  let instrument = "piano";

  function setInstrument(name) {
    if (INSTRUMENTS[name]) instrument = name;
  }

  const instrumentSelect = document.getElementById("main-keyboard-instrument");
  if (instrumentSelect) {
    instrumentSelect.addEventListener("change", () => setInstrument(instrumentSelect.value));
  }

  // One note into any context and any node (the Studio uses this for its piano roll and for
  // WAV export). Same instruments as playNote, but no pedal, wheel or vibrato.
  const noiseBuffers = new WeakMap();
  function noiseFor(ctx) {
    if (!noiseBuffers.has(ctx)) {
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      noiseBuffers.set(ctx, buffer);
    }
    return noiseBuffers.get(ctx);
  }

  // opts (all optional): glide = semitones to slide by the end of the note,
  // fadeIn / fadeOut = share of the note (0 to 1) spent rising from / falling to silence.
  function noteInto(ctx, dest, midi, start, duration, volume = 0.12, name = instrument, opts) {
    const inst = INSTRUMENTS[name] || INSTRUMENTS.piano;
    const peak = volume * registerGain(midi) * inst.trim;
    const freq = midiToFreq(midi) * (inst.octave || 1);
    const low = inst.lowBoost ? Math.min(1, Math.max(0, (60 - midi) / 24)) : 0;
    const end = start + duration;
    const rel = opts ? Math.max(0, Math.min(6, Number(opts.release) || 0)) : 0; // extra ring-out after the note ends
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + inst.attack);
    if (inst.sustain) {
      const level = peak * inst.sustain;
      gain.gain.exponentialRampToValueAtTime(level, start + inst.attack + 0.05);
      gain.gain.setValueAtTime(level, Math.max(start + inst.attack + 0.05, end - 0.1));
      gain.gain.exponentialRampToValueAtTime(0.0001, end + 0.05 + rel);
    } else if (inst.hold) {
      gain.gain.setValueAtTime(peak, Math.max(start + inst.attack, end - 0.02));
      gain.gain.exponentialRampToValueAtTime(0.0001, end + 0.14 + rel);
    } else {
      gain.gain.exponentialRampToValueAtTime(0.0001, start + Math.min(duration + 0.25 + rel, inst.life));
    }
    const glide = opts && Number(opts.glide) ? Number(opts.glide) : 0;
    const fi = opts ? Math.max(0, Math.min(1, Number(opts.fadeIn) || 0)) : 0;
    const fo = opts ? Math.max(0, Math.min(1 - fi, Number(opts.fadeOut) || 0)) : 0;
    if (fi > 0 || fo > 0) {
      const fade = ctx.createGain();
      fade.gain.setValueAtTime(fi > 0 ? 0 : 1, start);
      if (fi > 0) fade.gain.linearRampToValueAtTime(1, start + fi * duration);
      if (fo > 0) {
        fade.gain.setValueAtTime(1, end - fo * duration);
        fade.gain.linearRampToValueAtTime(0, end);
      }
      gain.connect(fade);
      fade.connect(dest);
    } else {
      gain.connect(dest);
    }
    const slide = (param, from) => {
      param.setValueAtTime(from, start);
      if (glide) param.exponentialRampToValueAtTime(from * Math.pow(2, glide / 12), end);
    };
    let sink = gain;
    if (inst.cutoff) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = inst.cutoff;
      filter.connect(gain);
      sink = filter;
    }
    if (inst.drive) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = driveCurve(inst.drive);
      shaper.oversample = "2x";
      shaper.connect(sink);
      sink = shaper;
    }
    inst.partials.forEach(([type, multiple, level, decayK], index) => {
      let amount = level;
      if (index === 2) amount += 0.54 * low;
      if (index === 3) amount += 0.4 * low;
      const part = ctx.createGain();
      if (type === "ks") {
        const src = ctx.createBufferSource();
        src.buffer = pluckBuffer(ctx, midi, duration + rel + 0.3, inst.ks, inst.loss);
        slide(src.playbackRate, 1);
        part.gain.setValueAtTime(amount, start);
        src.connect(part);
        part.connect(sink);
        src.start(start);
        src.stop(end + 0.4 + rel);
        return;
      }
      if (inst.noise) {
        const src = ctx.createBufferSource();
        src.buffer = noiseFor(ctx);
        src.loop = true;
        const band = ctx.createBiquadFilter();
        band.type = "bandpass";
        band.Q.value = inst.q || 3;
        slide(band.frequency, Math.min(18000, freq));
        part.gain.setValueAtTime(amount, start);
        src.connect(band);
        band.connect(part);
        part.connect(sink);
        src.start(start, Math.random());
        src.stop(end + 0.35 + rel);
        return;
      }
      const osc = ctx.createOscillator();
      osc.type = type;
      slide(osc.frequency, freq * multiple);
      part.gain.setValueAtTime(amount, start);
      if (decayK) part.gain.setTargetAtTime(amount * 0.04, start + inst.attack, pianoTau(midi) / decayK);
      osc.connect(part);
      part.connect(sink);
      osc.start(start);
      osc.stop(end + 0.35 + rel);
    });
  }

  // A plucked string: noise in a short loop that loses a little energy each time round. It is worked out
  // as a buffer, because a delay loop made from Web Audio nodes cannot reach high pitches.
  const pluckCache = new Map();
  function pluckBuffer(ctx, midi, seconds, bright, loss) {
    const rate = ctx.sampleRate;
    const len = Math.ceil(rate * Math.min(6, Math.max(0.4, Math.ceil(seconds * 4) / 4)));
    const key = rate + ":" + midi + ":" + len + ":" + bright + ":" + loss;
    if (pluckCache.has(key)) return pluckCache.get(key);
    const period = Math.max(2, Math.round(rate / midiToFreq(midi)));
    const ring = new Float32Array(period);
    let seed = (midi * 7919 + 13) >>> 0;
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
    let soft = 0;
    for (let i = 0; i < period; i++) { soft += bright * (rand() - soft); ring[i] = soft; }
    const buffer = ctx.createBuffer(1, len, rate);
    const out = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const at = i % period;
      const v = ring[at];
      out[i] = v;
      ring[at] = loss * 0.5 * (v + ring[(at + 1) % period]);
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0) for (let i = 0; i < len; i++) out[i] /= peak;
    if (pluckCache.size > 160) pluckCache.delete(pluckCache.keys().next().value);
    pluckCache.set(key, buffer);
    return buffer;
  }

  const driveCurves = new Map();
  function driveCurve(amount) {
    if (!driveCurves.has(amount)) {
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(amount * x) / Math.tanh(amount);
      }
      driveCurves.set(amount, curve);
    }
    return driveCurves.get(amount);
  }

  function getMix() {
    getBus();
    return compressor; // a node that stays put, for things that feed the shared output
  }

  function getInstrument() {
    return instrument;
  }

  function playNote(midi, duration = 1.8, when = 0, volume = 0.12) {
    const ctx = getCtx();
    const bus = getBus();
    const inst = INSTRUMENTS[instrument];
    const start = ctx.currentTime + when;
    const peak = volume * registerGain(midi) * inst.trim;
    const freq = midiToFreq(midi) * (inst.octave || 1);
    const low = inst.lowBoost ? Math.min(1, Math.max(0, (60 - midi) / 24)) : 0;
    const end = start + duration;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + inst.attack);
    if (inst.sustain) {
      // hold while the key is down, then fade at the very end
      const level = peak * inst.sustain;
      const settle = Math.min(start + inst.attack + 0.3, start + duration * 0.5);
      gain.gain.exponentialRampToValueAtTime(level, Math.max(settle, start + inst.attack + 0.01));
      gain.gain.setValueAtTime(level, Math.max(settle, end - 0.12));
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
    } else if (inst.hold) {
      gain.gain.setValueAtTime(peak, Math.max(start + inst.attack, end - 0.3));
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
    } else {
      gain.gain.exponentialRampToValueAtTime(0.0001, start + Math.min(duration, inst.life));
    }

    // the damper: stays wide open until we lower it (that is how a key lets go)
    const damper = ctx.createGain();
    gain.connect(damper);
    damper.connect(bus);

    let sink = gain;
    if (inst.cutoff) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = inst.cutoff;
      filter.connect(gain);
      sink = filter;
    }
    if (inst.drive) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = driveCurve(inst.drive);
      shaper.oversample = "2x";
      shaper.connect(sink);
      sink = shaper;
    }

    const oscs = [];
    inst.partials.forEach(([type, multiple, level, decayK], index) => {
      let amount = level;
      if (index === 2) amount += 0.54 * low; // low piano notes get extra upper harmonics
      if (index === 3) amount += 0.4 * low;
      const part = ctx.createGain();
      let osc;
      let entry = part;
      if (type === "ks") {
        osc = ctx.createBufferSource();
        osc.buffer = pluckBuffer(ctx, midi, Math.min(6, duration), inst.ks, inst.loss);
      } else if (inst.noise) {
        osc = ctx.createBufferSource();
        osc.buffer = noiseFor(ctx);
        osc.loop = true;
        entry = ctx.createBiquadFilter();
        entry.type = "bandpass";
        entry.Q.value = inst.q || 3;
        entry.frequency.value = Math.min(18000, freq);
        entry.connect(part);
      } else {
        osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq * multiple;
      }
      if (type === "ks") osc.playbackRate.value = 1;
      osc.detune.value = bendCents;
      vibrato.connect(osc.detune);
      liveOscs.add(osc);
      osc.onended = () => {
        liveOscs.delete(osc);
        try { vibrato.disconnect(osc.detune); } catch (e) { /* already gone */ }
      };
      part.gain.setValueAtTime(amount, start);
      if (decayK) part.gain.setTargetAtTime(amount * 0.04, start + inst.attack, pianoTau(midi) / decayK);
      osc.connect(entry);
      part.connect(sink);
      osc.start(start);
      osc.stop(end + 0.05);
      oscs.push(osc);
    });
    return { damper, oscs, end: end + 0.05, tau: null };
  }

  // ---------- sustain pedal ----------
  // Off damps a released key fast. Half lets it ring on, fading. Full lets it ring until the pedal lifts.
  const DAMP_TAU = { off: 0.08, half: 0.7 };
  const sounding = new Set(); // voices whose key is up but are still ringing
  let pedalLatched = 0; // set by the on-screen buttons: 0, 0.5 or 1
  let pedalKey = 0; // set by Space (1) or Shift (0.5) while held
  let pedalMidi = 0; // set by a MIDI keyboard's sustain pedal (CC 64)
  let pedalLevel = 0;

  function damp(voice, tau, delay = 0) {
    const now = audioCtx.currentTime;
    voice.tau = tau;
    voice.damper.gain.setTargetAtTime(0, now + delay, tau);
    const stopAt = Math.min(voice.end, now + delay + tau * 8 + 0.05);
    voice.oscs.forEach((osc) => {
      try { osc.stop(stopAt); } catch (e) { /* already stopped */ }
    });
  }

  // a key came up: let go according to the pedal
  function releaseVoice(voice, delay = 0) {
    if (!audioCtx) return;
    if (pedalLevel >= 1) {
      sounding.add(voice);
    } else if (pedalLevel > 0) {
      damp(voice, DAMP_TAU.half, delay);
      sounding.add(voice);
    } else {
      damp(voice, DAMP_TAU.off, delay);
    }
  }

  function setPedal(level) {
    const lower = level < pedalLevel;
    pedalLevel = level;
    if (lower && audioCtx) {
      sounding.forEach((voice) => {
        if (voice.end < audioCtx.currentTime) sounding.delete(voice);
        else if (level === 0) {
          damp(voice, DAMP_TAU.off);
          sounding.delete(voice);
        } else damp(voice, DAMP_TAU.half);
      });
    }
    drawPedal();
  }

  function refreshPedal() {
    setPedal(Math.max(pedalLatched, pedalKey, pedalMidi));
  }

  function drawPedal() {
    document.querySelectorAll("[data-pedal]").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.pedal) === pedalLevel));
    });
  }

  document.querySelectorAll("[data-pedal]").forEach((button) => {
    button.addEventListener("click", () => {
      pedalLatched = Number(button.dataset.pedal);
      refreshPedal();
      button.blur();
    });
  });

  function pedalFromKey(event) {
    const tag = event.target.tagName;
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag)) return;
    if (event.code === "Space") {
      pedalKey = event.type === "keydown" ? 1 : pedalKey === 1 ? 0 : pedalKey;
      event.preventDefault();
    } else if (event.key === "Shift") {
      pedalKey = event.type === "keydown" ? (pedalKey === 1 ? 1 : 0.5) : pedalKey === 0.5 ? 0 : pedalKey;
    } else return;
    refreshPedal();
  }
  document.addEventListener("keydown", pedalFromKey);
  document.addEventListener("keyup", pedalFromKey);
  window.addEventListener("blur", () => {
    pedalKey = 0;
    refreshPedal();
  });
  drawPedal();

  function playChord(midiList, volume = 0.12) {
    stopAll();
    midiList.forEach((midi) => playNote(midi, 1.8, 0, volume));
  }

  // Silence everything that is sounding or queued, and stop every keyboard's schedule.
  function stopAll() {
    keyboards.forEach((board) => board.cancel());
    sounding.clear();
    if (master) {
      const old = master;
      old.gain.cancelScheduledValues(audioCtx.currentTime);
      old.gain.setTargetAtTime(0, audioCtx.currentTime, 0.015);
      setTimeout(() => old.disconnect(), 200);
      master = null;
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  }

  // ---------- pause / stop buttons ----------
  function syncTransport() {
    const pause = document.getElementById("main-transport-pause");
    if (!pause) return;
    pause.disabled = !audioCtx;
    const paused = audioCtx && audioCtx.state === "suspended";
    pause.textContent = paused ? "▶ Resume" : "❚❚ Pause";
  }

  function togglePause() {
    if (!audioCtx) return;
    if (audioCtx.state === "running") audioCtx.suspend();
    else audioCtx.resume();
  }

  const pauseButton = document.getElementById("main-transport-pause");
  const stopButton = document.getElementById("main-transport-stop");
  if (pauseButton) pauseButton.addEventListener("click", togglePause);
  if (stopButton) {
    stopButton.addEventListener("click", () => {
      stopAll();
      keyboards.forEach((board) => board.light([]));
    });
  }
  syncTransport();

  // ---------- talking to Django ----------
  async function api(url, params) {
    const response = await fetch(url + "?" + new URLSearchParams(params).toString());
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Something went wrong");
    return data;
  }

  // ---------- keyboard ----------
  // The keyboard shows three octaves at a time (37 keys) and slides along an 88-key piano, A0 to C8.
  const PIANO_LOW = 21;
  const PIANO_HIGH = 108;

  function createKeyboard(keysEl, caseEl, startLow = 48, startHigh = 84, options = {}) {
    // one keyboard per page: sections that share a page (Learn, Practice) all get the same one
    if (keysEl.__tcsBoard) return keysEl.__tcsBoard;
    let low = startLow;
    let high = startHigh;
    const mini = options.mini === true; // the small floating copy
    let dock = null;
    const keyByMidi = {};
    const leftOf = {};
    let whiteCount = 0;
    let timer = null;
    let keyHandler = null;

    // ---------- pressing and gliding ----------
    // Press a key and it sounds until you let go. Keep the button down and slide
    // across the keys and each one you cross sounds in turn: a glissando.
    const HOLD_MIN = 0.3; // a very quick tap still rings this long (seconds)
    const LOOKAHEAD = 3; // seconds of a scheduled song that are queued in advance
    let noteHandler = null; // the recorder listens here
    const touches = new Map(); // pointerId -> { midi, voice, at }

    function keyAt(x, y) {
      const el = document.elementFromPoint(x, y);
      return el && keysEl.contains(el) && el.dataset.midi ? Number(el.dataset.midi) : null;
    }

    function press(id, midi, volume) {
      if (audioCtx && audioCtx.state === "suspended") stopAll();
      const voice = playNote(midi, 9, 0, volume);
      touches.set(id, { midi, voice, at: audioCtx.currentTime });
      if (!keyByMidi[midi]) reveal([midi]); // a note outside the three octaves on screen: slide to it
      if (keyByMidi[midi]) keyByMidi[midi].classList.add("is-down");
      else flashEdge(midi);
      document.dispatchEvent(new CustomEvent("pianokit:play"));
      if (noteHandler) noteHandler(midi, true, volume);
    }

    function lift(id) {
      const held = touches.get(id);
      if (!held) return;
      touches.delete(id);
      const stillDown = [...touches.values()].some((other) => other.midi === held.midi);
      if (!stillDown && keyByMidi[held.midi]) keyByMidi[held.midi].classList.remove("is-down");
      releaseVoice(held.voice, Math.max(0, held.at + HOLD_MIN - audioCtx.currentTime));
      if (noteHandler) noteHandler(held.midi, false);
    }

    keysEl.addEventListener("pointerdown", (event) => {
      if (event.button > 0) return;
      const midi = keyAt(event.clientX, event.clientY);
      if (midi === null) return;
      keysEl.setPointerCapture(event.pointerId);
      keyByMidi[midi].classList.remove("is-lit"); // pressing a highlighted key un-highlights it
      press(event.pointerId, midi);
      if (keyHandler) keyHandler(midi);
    });

    keysEl.addEventListener("pointermove", (event) => {
      const held = touches.get(event.pointerId);
      if (!held || keyHandler) return; // no gliding while picking notes
      const midi = keyAt(event.clientX, event.clientY);
      if (midi === null || midi === held.midi) return;
      lift(event.pointerId);
      press(event.pointerId, midi);
    });

    ["pointerup", "pointercancel"].forEach((name) => {
      keysEl.addEventListener(name, (event) => lift(event.pointerId));
    });

    let litNotes = [];
    let markedNotes = [];
    const rangeListeners = [];

    function build() {
      keysEl.replaceChildren();
      Object.keys(keyByMidi).forEach((midi) => delete keyByMidi[midi]);
      Object.keys(leftOf).forEach((midi) => delete leftOf[midi]);
      whiteCount = 0;
      for (let midi = low; midi <= high; midi++) {
        const key = document.createElement("div");
        key.dataset.midi = midi;
        if (midi % 12 === 0) {
          // C3, C4... shows which octave is on screen. A real element (not ::after), because a picked key needs ::after for its dot
          key.dataset.c = "C" + (midi / 12 - 1);
          const tag = document.createElement("span");
          tag.className = "main-keyboard-octave";
          tag.textContent = key.dataset.c;
          key.appendChild(tag);
        }
        if (BLACK_PCS.includes(midi % 12)) {
          key.className = "main-keyboard-key main-keyboard-key-black";
        } else {
          key.className = "main-keyboard-key main-keyboard-key-white";
          whiteCount += 1;
        }
        keysEl.appendChild(key);
        keyByMidi[midi] = key;
      }
      // keys that were down, lit or picked stay that way after a slide
      touches.forEach((held) => {
        if (keyByMidi[held.midi]) keyByMidi[held.midi].classList.add("is-down");
      });
      litNotes.forEach((midi) => {
        if (keyByMidi[midi]) keyByMidi[midi].classList.add("is-lit");
      });
      markedNotes.forEach((midi) => {
        if (keyByMidi[midi]) keyByMidi[midi].classList.add("is-picked");
      });
    }

    // Size the keys to fill the case (between 34px and 64px per white key).
    let lastRoom = -1;
    function layout() {
      const style = getComputedStyle(caseEl);
      const room = caseEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (room === lastRoom) return;
      lastRoom = room;
      const white = Math.max(mini ? 12 : 34, Math.min(mini ? 26 : 64, Math.floor(room / whiteCount)));
      const black = Math.round(white * 0.62);
      keysEl.style.setProperty("--white-w", white + "px");
      keysEl.style.setProperty("--black-w", black + "px");
      keysEl.style.setProperty("--white-h", Math.round(white * (mini ? 3.4 : 4.2)) + "px");
      keysEl.style.setProperty("--black-h", Math.round(white * (mini ? 2 : 2.6)) + "px");
      keysEl.style.width = white * whiteCount + "px";

      let whitesBefore = 0;
      for (let midi = low; midi <= high; midi++) {
        if (BLACK_PCS.includes(midi % 12)) {
          leftOf[midi] = whitesBefore * white - black / 2;
        } else {
          leftOf[midi] = whitesBefore * white;
          whitesBefore += 1;
        }
        keyByMidi[midi].style.left = leftOf[midi] + "px";
      }
    }

    // ---------- the three-octave window ----------
    function startOf(midi) {
      return Math.floor(midi / 12) * 12; // the C at or below this note
    }

    function getRange() {
      return { low, high, start: low === PIANO_LOW ? 24 : low };
    }

    function setRange(newLow, newHigh) {
      if (newLow === low && newHigh === high) return;
      low = newLow;
      high = newHigh;
      build();
      lastRoom = -1;
      layout();
      caseEl.scrollLeft = 0;
      if (dock) dock.setRange(low, high);
      rangeListeners.forEach((fn) => fn(getRange()));
    }

    // Slide the window so it starts on this C. C1 is the lowest start (it also shows A0 to B0)
    // and C5 the highest (it ends on C8), so you can never go past the 88 keys of a piano.
    function setOctave(startC) {
      const start = Math.max(24, Math.min(72, Math.round(startC / 12) * 12));
      setRange(start === 24 ? PIANO_LOW : start, start + 36);
    }

    function shiftOctave(step) {
      setOctave(getRange().start + step * 12);
    }

    function onRange(fn) {
      rangeListeners.push(fn);
      fn(getRange());
    }

    // If a note is off screen, slide to its octave (it lands in the middle octave of the window).
    function reveal(midiList) {
      const known = midiList.filter((midi) => midi >= PIANO_LOW && midi <= PIANO_HIGH);
      if (!known.length || known.every((midi) => keyByMidi[midi])) return;
      setOctave(startOf(Math.round((Math.min(...known) + Math.max(...known)) / 2)) - 12);
    }

    function centerOn(midi) {
      reveal([midi]);
    }

    // A note beyond the last key (a MIDI keyboard shifted several octaves) cannot be shown, so say so.
    let edgeLow = null;
    let edgeHigh = null;
    let edgeTimer = null;
    function flashEdge(midi) {
      if (mini || !caseEl.parentNode) return;
      if (!edgeLow) {
        const wrap = caseEl.parentNode;
        edgeLow = document.createElement("span");
        edgeLow.className = "main-keyboard-edge main-keyboard-edge-low";
        edgeHigh = document.createElement("span");
        edgeHigh.className = "main-keyboard-edge main-keyboard-edge-high";
        wrap.append(edgeLow, edgeHigh);
      }
      const below = midi < low;
      const badge = below ? edgeLow : edgeHigh;
      (below ? edgeHigh : edgeLow).classList.remove("is-on");
      badge.textContent = below ? "\u25C0 " + noteName(midi) : noteName(midi) + " \u25B6";
      badge.style.top = caseEl.offsetTop + 6 + "px";
      badge.classList.add("is-on");
      clearTimeout(edgeTimer);
      edgeTimer = setTimeout(() => {
        edgeLow.classList.remove("is-on");
        edgeHigh.classList.remove("is-on");
      }, 900);
    }

    // paint only changes which keys are lit; light also scrolls, glows the backdrop and feeds the dock
    function paint(midiList) {
      litNotes = midiList.slice();
      Object.values(keyByMidi).forEach((key) => key.classList.remove("is-lit"));
      midiList.forEach((midi) => {
        if (keyByMidi[midi]) keyByMidi[midi].classList.add("is-lit");
      });
    }

    function light(midiList) {
      paint(midiList);
      reveal(midiList);
      if (midiList.length) document.dispatchEvent(new CustomEvent("pianokit:play"));
      if (dock) dock.follow(midiList);
    } 

    // Pick mode: onKey(fn) sends every key click to fn(midi); onKey(null) turns it off.
    function onKey(fn) {
      keyHandler = fn;
      caseEl.classList.toggle("is-picking", Boolean(fn));
    }

    // Mark the keys the user has picked (a separate look from the lit keys).
    function mark(midiList) {
      markedNotes = midiList.slice();
      Object.keys(keyByMidi).forEach((midi) => {
        keyByMidi[midi].classList.toggle("is-picked", midiList.includes(Number(midi)));
      });
    }

    function cancel() {
      clearInterval(timer);
      timer = null;
    }

    // events: [{ t: seconds from now, midi: [numbers], dur: seconds }]
    // Lights follow the audio clock, so Pause freezes the keys together with the sound.
    function schedule(events) {
      stopAll();
      const ctx = getCtx();
      const origin = ctx.currentTime + 0.05;
      const queue = events.slice().sort((a, b) => a.t - b.t);
      const end = queue.reduce((latest, ev) => Math.max(latest, ev.t + ev.dur), 0) + 0.3;
      let next = 0;
      let planned = 0;

      // sound is queued only a few seconds ahead, so a long song never loads every note at once
      function plan(now) {
        while (planned < queue.length && queue[planned].t <= now + LOOKAHEAD) {
          const ev = queue[planned];
          ev.midi.forEach((m) => playNote(m, ev.dur, Math.max(0, origin - ctx.currentTime + ev.t), ev.volume));
          planned += 1;
        }
      }
      plan(0);

      timer = setInterval(() => {
        const now = ctx.currentTime - origin;
        plan(now);
        while (next < queue.length && now >= queue[next].t) {
          const ev = queue[next];
          if (ev.show !== false) light(ev.show || ev.midi); // show: which keys to light, or false for none
          next += 1;
        }
        if (now >= end) {
          cancel();
          light([]);
        }
      }, 25);
    }

    build();
    layout();
    if (window.ResizeObserver) new ResizeObserver(layout).observe(caseEl);
    else window.addEventListener("resize", layout);

    // MIDI keyboards: a note on or off, the same as pressing and lifting a key with the mouse
    function down(midi, volume) {
      const id = "midi-" + midi;
      if (touches.has(id)) lift(id);
      if (keyByMidi[midi]) keyByMidi[midi].classList.remove("is-lit");
      press(id, midi, volume);
      if (keyHandler) keyHandler(midi);
    }

    function up(midi) {
      lift("midi-" + midi);
    }

    // onNote(fn): fn(midi, isOn, volume) for every key pressed or lifted, by mouse, touch or MIDI
    function onNote(fn) {
      noteHandler = fn;
    }

    const board = {
      light, paint, centerOn, reveal, schedule, cancel, onKey, mark, down, up, onNote,
      setRange, setOctave, shiftOctave, getRange, onRange,
    };

    // ---------- the floating piano ----------
    // When this keyboard is scrolled out of view and something plays, a small copy
    // slides up from the bottom of the screen and lights the same keys.
    function makeDock() {
      const el = document.createElement("div");
      el.className = "main-dock";
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", "Keys being played");
      el.innerHTML =
        '<div class="main-dock-case"><div class="main-dock-keys main-keyboard-keys"></div></div>' +
        '<button type="button" class="main-dock-stop">\u25A0 Stop</button>';
      document.body.appendChild(el);
      const copy = createKeyboard(el.querySelector(".main-dock-keys"), el.querySelector(".main-dock-case"), low, high, { mini: true });

      let visible = true;
      let hideTimer = null;
      function open() {
        clearTimeout(hideTimer);
        el.classList.add("is-open");
      }
      function close() {
        clearTimeout(hideTimer);
        el.classList.remove("is-open");
      }

      if (window.IntersectionObserver) {
        new IntersectionObserver(
          ([entry]) => {
            visible = entry.intersectionRatio > 0.25;
            if (visible) close();
          },
          { threshold: [0, 0.25, 0.5] }
        ).observe(caseEl);
      }

      el.querySelector(".main-dock-stop").addEventListener("click", () => {
        stopAll();
        keyboards.forEach((each) => each.light([]));
        close();
      });

      return {
        setRange(newLow, newHigh) {
          copy.setRange(newLow, newHigh);
        },
        follow(midiList) {
          copy.paint(midiList);
          if (midiList.length) {
            if (!visible) open();
          } else {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(close, 1500); // linger a moment after the last note
          }
        },
      };
    }

    if (!mini) dock = makeDock();
    if (!mini) {
      const downButton = document.getElementById("main-octave-down");
      const upButton = document.getElementById("main-octave-up");
      const label = document.getElementById("main-octave-label");
      if (downButton && upButton && label) {
        onRange((range) => {
          label.textContent = noteName(range.low) + " \u2013 " + noteName(range.high);
          downButton.disabled = range.start <= 24;
          upButton.disabled = range.start >= 72;
        });
        downButton.addEventListener("click", () => shiftOctave(-1));
        upButton.addEventListener("click", () => shiftOctave(1));
      }
    }
    const clearButton = document.getElementById("main-transport-clear");
    if (clearButton) clearButton.addEventListener("click", () => light([]));
    keyboards.push(board);
    if (!mini) mainBoard = board;
    keysEl.__tcsBoard = board;
    return board;
  }

  function setMidiPedal(level) {
    pedalMidi = level;
    refreshPedal();
  }

  function getBoard() {
    return mainBoard;
  }

  return {
    playNote, noteInto, getMix, getInstrument, playChord, stopAll, api, createKeyboard, getCtx, getBus,
    setInstrument, setMidiPedal, getBoard,
    setPitchBend, setVibrato, setTone, setLevel, noteName,
  };
})();