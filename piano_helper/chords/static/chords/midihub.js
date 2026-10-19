// MidiHub: the one place on every page that owns the Web MIDI connection.
// It turns raw bytes into plain messages, and it remembers that you were connected, so the next
// page you open reconnects by itself (no button, no permission prompt once the browser has allowed it).
// Anything on the page can listen:  MidiHub.on(function (msg) { ... })
// msg = { type, ch (1-16), a, b, value (0-1), key }  where key names the physical control,
// like "cc:1:21" (channel 1, controller 21) or "note:10:36" (channel 10, note 36).
(function () {
  "use strict";
  if (window.MidiHub) return; // loaded twice: keep the first one
  const PREF_KEY = "tcsmusic-midi-on";
  let access = null;
  let busy = false;
  let message = "";
  const listeners = [];
  const stateListeners = [];

  function emit(msg) { listeners.forEach((fn) => fn(msg)); }

  function parse(data) {
    const status = data[0], a = data[1] || 0, b = data[2] || 0;
    const kind = status & 0xf0, ch = (status & 0x0f) + 1;
    if (status >= 0xf0) return null; // clock, sysex and friends
    if (kind === 0x90 && b > 0) return { type: "noteon", ch, a, b, value: b / 127, key: "note:" + ch + ":" + a };
    if (kind === 0x80 || kind === 0x90) return { type: "noteoff", ch, a, b, value: 0, key: "note:" + ch + ":" + a };
    if (kind === 0xb0) return { type: "cc", ch, a, b, value: b / 127, key: "cc:" + ch + ":" + a };
    if (kind === 0xe0) {
      const norm = Math.max(-1, Math.min(1, ((b << 7) + a - 8192) / 8192));
      return { type: "bend", ch, a, b, value: (norm + 1) / 2, norm, key: "bend:" + ch };
    }
    if (kind === 0xd0) return { type: "pressure", ch, a, b: a, value: a / 127, key: "at:" + ch };
    if (kind === 0xa0) return { type: "poly", ch, a, b, value: b / 127, key: "poly:" + ch + ":" + a };
    if (kind === 0xc0) return { type: "program", ch, a, b: a, value: a / 127, key: "pc:" + ch + ":" + a };
    return null;
  }

  function onMessage(event) {
    const msg = parse(event.data);
    if (msg) emit(msg);
  }

  function listen() {
    access.inputs.forEach((input) => { input.onmidimessage = onMessage; });
  }

  function names() {
    const out = [];
    if (access) access.inputs.forEach((input) => out.push(input.name || "MIDI device"));
    return out;
  }

  function status() {
    return { connected: !!access, busy, devices: names(), message };
  }

  function emitState() { const s = status(); stateListeners.forEach((fn) => fn(s)); }

  function remember(on) {
    try { localStorage.setItem(PREF_KEY, on ? "on" : "off"); } catch (error) { /* private window */ }
  }

  async function connect(quiet) {
    if (access || busy) return status();
    if (!navigator.requestMIDIAccess) {
      message = "This browser has no MIDI support. Try Chrome, Edge or Opera.";
      emitState();
      return status();
    }
    busy = true;
    message = quiet ? "Reconnecting your MIDI keyboard…" : "Waiting for permission…";
    emitState();
    try {
      access = await navigator.requestMIDIAccess();
    } catch (error) {
      access = null;
      busy = false;
      message = "MIDI access was blocked. Allow it in the address bar and try again.";
      emitState();
      return status();
    }
    busy = false;
    message = "";
    listen();
    access.onstatechange = () => { listen(); emitState(); };
    remember(true);
    emitState();
    return status();
  }

  function disconnect(keepPreference) {
    if (!access) return;
    access.inputs.forEach((input) => { input.onmidimessage = null; });
    access.onstatechange = null;
    access = null;
    message = "";
    if (!keepPreference) remember(false);
    emitState();
  }

  window.MidiHub = {
    connect, disconnect, status,
    toggle() { return access ? (disconnect(), Promise.resolve(status())) : connect(); },
    on(fn) { listeners.push(fn); },
    // a late listener hears the current state straight away, so every page's button starts in the right place
    onState(fn) { stateListeners.push(fn); fn(status()); },
    // for tests and for pretend controllers
    inject(msg) { emit(msg); },
    parse,
  };

  // Connected on the last page? Connect again here. Only when the browser has already allowed MIDI,
  // so nobody gets a surprise permission prompt just for opening a page.
  (async function reconnect() {
    let wanted = false;
    try { wanted = localStorage.getItem(PREF_KEY) === "on"; } catch (error) { /* nothing saved */ }
    if (!wanted || !navigator.requestMIDIAccess) return;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const permission = await navigator.permissions.query({ name: "midi" });
        if (permission.state !== "granted") return;
      } else {
        return;
      }
    } catch (error) { return; }
    connect(true);
  })();
})();
