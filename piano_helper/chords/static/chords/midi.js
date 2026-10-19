(function () {
  "use strict";
  const K = window.PianoKit;
  const $ = (id) => document.getElementById(id);

  const connectButton = $("main-midi-connect");
  if (!connectButton || !K) return;

  const statusOut = $("main-midi-status");
  const controlsNote = $("main-midi-controls-note");
  const controlsList = $("main-midi-controls-list");
  const pitchDot = $("main-midi-pitch-dot");

  const MAP_KEY = "tcsmusic-midi-map";
  const FUNCTIONS = { none: "Nothing", volume: "Volume", vibrato: "Vibrato", tone: "Brightness" };
  const NAMES = { 1: "Mod wheel", 7: "Volume", 11: "Expression", 74: "Brightness" };

  const Hub = window.MidiHub;
  if (!Hub) return;
  const sounding = new Set(); // notes the keyboard is holding down
  const rows = new Map();     // controller number -> its row on the page
  let map = { 1: "vibrato", 7: "volume", 74: "tone" }; // which controller drives which sound control

  // Controller names are remembered in this browser; one controller can drive one thing.
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_KEY) || "null");
    if (saved && typeof saved === "object") {
      const clean = {};
      Object.keys(saved).forEach((cc) => {
        if (/^\d+$/.test(cc) && FUNCTIONS[saved[cc]]) clean[cc] = saved[cc];
      });
      map = clean;
    }
  } catch (error) { /* bad or blocked storage: keep the defaults */ }

  function saveMap() {
    try { localStorage.setItem(MAP_KEY, JSON.stringify(map)); } catch (error) { /* fine */ }
  }

  function say(text) {
    statusOut.textContent = text;
  }

  // ---------- notes ----------
  function noteOn(note, velocity) {
    const board = K.getBoard();
    if (!board) return;
    if (sounding.has(note)) board.up(note);
    sounding.add(note);
    board.down(note, 0.03 + 0.17 * (velocity / 127)); // louder when you hit harder
  }

  function noteOff(note) {
    const board = K.getBoard();
    if (!board || !sounding.has(note)) return;
    board.up(note);
    sounding.delete(note);
  }

  function allOff() {
    [...sounding].forEach(noteOff);
  }

  function sustain(value) {
    K.setMidiPedal(value < 32 ? 0 : value < 96 ? 0.5 : 1);
  }

  // ---------- wheels, faders and knobs ----------
  function apply(fn, amount) {
    if (fn === "volume") K.setLevel(amount);
    else if (fn === "vibrato") K.setVibrato(amount);
    else if (fn === "tone") K.setTone(amount);
  }

  function pitchWheel(low, high) {
    const norm = Math.max(-1, Math.min(1, ((high << 7) + low - 8192) / 8192));
    K.setPitchBend(norm);
    if (pitchDot) pitchDot.style.left = ((norm + 1) / 2) * 100 + "%";
  }

  function makeRow(cc) {
    const row = document.createElement("div");
    row.className = "main-midi-control-row";
    const label = document.createElement("span");
    label.className = "main-midi-control-label";
    label.textContent = (NAMES[cc] ? NAMES[cc] + " · " : "") + "CC " + cc;
    const meter = document.createElement("div");
    meter.className = "main-midi-control-meter";
    const fill = document.createElement("span");
    fill.className = "main-midi-control-fill";
    meter.appendChild(fill);
    const assign = document.createElement("select");
    assign.className = "main-midi-control-assign";
    assign.setAttribute("aria-label", "What CC " + cc + " controls");
    Object.keys(FUNCTIONS).forEach((fn) => {
      const option = document.createElement("option");
      option.value = fn;
      option.textContent = FUNCTIONS[fn];
      assign.appendChild(option);
    });
    assign.value = map[cc] || "none";
    assign.addEventListener("change", () => {
      Object.keys(map).forEach((other) => {
        if (assign.value !== "none" && map[other] === assign.value) delete map[other];
      });
      if (assign.value === "none") delete map[cc];
      else map[cc] = assign.value;
      rows.forEach((each, number) => { each.assign.value = map[number] || "none"; });
      saveMap();
    });
    row.append(label, meter, assign);
    controlsList.appendChild(row);
    return { row, fill, assign };
  }

  function controller(cc, value) {
    if (!rows.has(cc)) rows.set(cc, makeRow(cc));
    const row = rows.get(cc);
    row.fill.style.width = (value / 127) * 100 + "%";
    if (map[cc]) apply(map[cc], value / 127);
  }

  function resetControls() {
    K.setPitchBend(0);
    K.setVibrato(0);
    K.setTone(1);
    K.setLevel(1);
    K.setMidiPedal(0);
    if (pitchDot) pitchDot.style.left = "50%";
    rows.forEach((row) => row.row.remove());
    rows.clear();
  }

  // ---------- messages (they come from the one shared MidiHub, on every page) ----------
  function onMessage(m) {
    if (m.type === "noteon") noteOn(m.a, m.b);
    else if (m.type === "noteoff") noteOff(m.a);
    else if (m.type === "bend") pitchWheel(m.a, m.b);
    else if (m.type === "cc" && m.a === 64) sustain(m.b);
    else if (m.type === "cc" && (m.a === 123 || m.a === 120)) allOff();
    else if (m.type === "cc") controller(m.a, m.b);
  }
  Hub.on(onMessage);

  // ---------- connect and disconnect ----------
  let wasConnected = false;
  Hub.onState((s) => {
    connectButton.setAttribute("aria-pressed", String(s.connected));
    connectButton.textContent = s.connected ? "🎹 Disconnect MIDI" : "🎹 Connect MIDI";
    if (s.connected) {
      say(s.devices.length ? "Connected: " + s.devices.join(", ") : "No MIDI keyboard found. Plug one in.");
      controlsNote.textContent = "move a wheel, fader, knob or pad";
    } else {
      say(s.message || "Not connected");
      if (wasConnected) {
        allOff();
        resetControls();
        controlsNote.textContent = "connect a MIDI keyboard to see them";
      }
    }
    wasConnected = s.connected;
  });

  connectButton.addEventListener("click", () => {
    if (!Hub.status().connected) say("Waiting for permission…");
    Hub.toggle();
  });
})();
