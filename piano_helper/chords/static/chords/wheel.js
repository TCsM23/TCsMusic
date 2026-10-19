// The chord wheel (circle of fifths) and the chord chart. Both pick a root and a type
// and hand it to assistant.js through the "main-chord-pick" event on #main-wheel.
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const MAJORS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];        // clockwise from the top
  const MAJOR_TEXT = ["C", "G", "D", "A", "E", "B", "F♯", "D♭", "A♭", "E♭", "B♭", "F"];
  const MINOR_TEXT = ["Am", "Em", "Bm", "F♯m", "C♯m", "G♯m", "D♯m", "B♭m", "Fm", "Cm", "Gm", "Dm"];
  // positions 5, 6 and 7 are the spots where two spellings share one chord
  const MAJOR_ALT = { 5: "C♭", 6: "G♭", 7: "C♯" };
  const MINOR_ALT = { 5: "A♭m", 6: "E♭m", 7: "A♯m" };
  const COUNTS = ["0", "1♯", "2♯", "3♯", "4♯", "5♯", "6♯/6♭", "5♭", "4♭", "3♭", "2♭", "1♭"];
  const DIM_TEXT = MAJORS.map((pc, i) => (i >= 1 && i <= 5 ? SHARP : FLAT)[(pc + 11) % 12].replace("b", "♭").replace("#", "♯") + "°");
  const types = JSON.parse($("main-chord-types").textContent);
  const rootInput = $("main-chord-root");
  const typeInput = $("main-chord-quality");
  const wheel = $("main-wheel");

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach((k) => node.setAttribute(k, attrs[k]));
    if (parent) parent.appendChild(node);
    return node;
  }

  function arc(r1, r2, a1, a2) {
    const p = (r, a) => [r * Math.sin(a), -r * Math.cos(a)];
    const [x1, y1] = p(r2, a1), [x2, y2] = p(r2, a2), [x3, y3] = p(r1, a2), [x4, y4] = p(r1, a1);
    return `M${x1} ${y1} A${r2} ${r2} 0 0 1 ${x2} ${y2} L${x3} ${y3} A${r1} ${r1} 0 0 0 ${x4} ${y4} Z`;
  }

  // ---------- music facts the wheel needs ----------
  const SIG_OF_MAJOR = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
  const MINOR_TYPES = ["min", "m7", "m6", "m9", "madd9", "m7b5", "mmaj7", "dim", "dim7"];
  const isMinorType = (q) => MINOR_TYPES.indexOf(q) !== -1;
  const wrap = (i) => (i + 12) % 12;
  // what to add to each chord of a key (written for the major key; the relative minor shares these chords)
  const EXT_HINT = { maj: "Maj7 9 13", min: "m7 9 11", dom: "7 9 sus4 13", dim: "m7♭5" };
  const MAJOR_DEG = { 0: ["I", "Tonic"], "-1": ["IV", "Subdominant"], 1: ["V", "Dominant"] };

  // Which wheel cells are friends of the chord you picked, and why.
  // A cell is "outer" (major) or "inner" (minor) at a position 0-11 around the circle of fifths.
  function relations(keyMajor, minor) {
    const rel = {}; // "outer3" -> { role, degree, strong }
    const put = (ring, idx, degree, role, strong) => { rel[ring + wrap(idx)] = { degree, role, strong }; };
    const i = MAJORS.indexOf(keyMajor);
    if (!minor) {
      put("outer", i, "I", "Tonic", true);
      put("outer", i - 1, "IV", "Subdominant", true);
      put("outer", i + 1, "V", "Dominant", true);
      put("inner", i, "vi", "Relative minor", true);
      put("inner", i - 1, "ii", "Supertonic", false);
      put("inner", i + 1, "iii", "Mediant", false);
      put("dim", i, "vii°", "Leading tone", false);
    } else {
      put("inner", i, "i", "Tonic", true);
      put("inner", i - 1, "iv", "Subdominant", true);
      put("inner", i + 1, "v", "Dominant (minor)", true);
      put("outer", i, "III", "Relative major", true);
      put("outer", i - 1, "VI", "Submediant", false);
      put("outer", i + 1, "VII", "Subtonic", false);
      put("dim", i, "ii°", "Supertonic", false);
    }
    return rel;
  }

  // the seven chords of the key, in the order of the picked tonic
  function diatonicSeven(keyMajor, minor) {
    const M = keyMajor;
    const ch = [
      { pc: M, q: "maj", hint: EXT_HINT.maj, deg: "I", role: "Tonic" },
      { pc: (M + 2) % 12, q: "min", hint: EXT_HINT.min, deg: "ii", role: "Supertonic" },
      { pc: (M + 4) % 12, q: "min", hint: EXT_HINT.min, deg: "iii", role: "Mediant" },
      { pc: (M + 5) % 12, q: "maj", hint: EXT_HINT.maj, deg: "IV", role: "Subdominant" },
      { pc: (M + 7) % 12, q: "maj", hint: EXT_HINT.dom, deg: "V", role: "Dominant" },
      { pc: (M + 9) % 12, q: "min", hint: EXT_HINT.min, deg: "vi", role: "Relative minor" },
      { pc: (M + 11) % 12, q: "dim", hint: EXT_HINT.dim, deg: "vii°", role: "Leading tone" },
    ];
    if (!minor) return ch;
    const minorDeg = ["i", "ii°", "III", "iv", "v", "VI", "VII"];
    const minorRole = ["Tonic", "Supertonic", "Relative major", "Subdominant", "Dominant (minor)", "Submediant", "Subtonic"];
    return [5, 6, 0, 1, 2, 3, 4].map((k, n) => ({ ...ch[k], deg: minorDeg[n], role: minorRole[n] }));
  }

  function keyInfo(majorPc, minor) {
    const sig = SIG_OF_MAJOR[majorPc];
    const i = MAJORS.indexOf(majorPc);
    const name = minor ? MINOR_TEXT[i].replace("m", "") + " minor" : MAJOR_TEXT[i] + " major";
    const acc = sig === 0 ? "no sharps or flats" : Math.abs(sig) + (sig > 0 ? " sharp" : " flat") + (Math.abs(sig) > 1 ? "s" : "");
    return { name, acc, minor };
  }

  // which key the picked chord points at: a diminished chord is the vii° of the key a half step above it
  function context(pc, q) {
    if (q === "dim") return { minor: false, keyMajor: (pc + 1) % 12, ring: "dim" };
    const minor = isMinorType(q);
    return { minor, keyMajor: minor ? (pc + 3) % 12 : pc, ring: minor ? "inner" : "outer" };
  }

  // ---------- the wheel ----------
  const modeSelect = $("main-wheel-mode");
  const audioButton = $("main-wheel-audio");
  const rotateInput = $("main-wheel-rotate");
  const rotateOut = $("main-wheel-rotate-out");
  const relatedBox = $("main-wheel-related");
  let audioOn = true;
  let rotation = 0;

  const group = el("g", { id: "main-wheel-rot" }, wheel);
  const cells = [];
  MAJORS.forEach((pc, i) => {
    const a1 = ((i - 0.5) * 30 * Math.PI) / 180, a2 = ((i + 0.5) * 30 * Math.PI) / 180, mid = (i * 30 * Math.PI) / 180;
    [["maj", "outer", 64, 100, MAJOR_TEXT[i], pc, MAJOR_ALT[i]],
     ["min", "inner", 36, 64, MINOR_TEXT[i], (pc + 9) % 12, MINOR_ALT[i]],
     ["dim", "dim", 100, 118, DIM_TEXT[i], (pc + 11) % 12, null]].forEach(([q, ring, r1, r2, text, root, alt]) => {
      const g = el("g", { class: "main-wheel-cell main-wheel-cell-" + (q === "maj" ? "maj" : q === "min" ? "min" : "dim"), tabindex: "0", role: "button", "aria-label": text + " chord" }, group);
      const slice = el("path", { d: arc(r1, r2, a1, a2), class: "main-wheel-slice" }, g);
      const rm = (r1 + r2) / 2;
      const x = rm * Math.sin(mid), y = -rm * Math.cos(mid);
      const label = el("g", { transform: "translate(" + x + " " + y + ")" }, g);
      if (alt) { const alte = el("text", { x: 0, y: -5.5, class: "main-wheel-alt", "text-anchor": "middle" }, label); alte.textContent = alt; }
      const name = el("text", { x: 0, y: q === "dim" ? 2 : 1, class: "main-wheel-text", "text-anchor": "middle" }, label);
      name.textContent = text;
      const sub = el("text", { x: 0, y: 8, class: "main-wheel-sub", "text-anchor": "middle" }, label);
      const type = q === "dim" ? "dim" : q;
      const pick = () => choose(root, type);
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      cells.push({ g, label, slice, name, sub, x, y, root, q: type, ring, idx: i, hue: i * 30, title: el("title", {}, g) });
    });
  });
  // outline round the picked key's seven chords (three positions, all three rings), drawn above the cells
  const outline = el("path", { class: "main-wheel-outline", d: "" }, group);
  // accidental counts, one per position, and the two direction hints (they stay upright, outside the spin)
  const countLabels = MAJORS.map((pc, i) => {
    const mid = (i * 30 * Math.PI) / 180;
    const t = el("text", { class: "main-wheel-count", "text-anchor": "middle", x: 0, y: 0 }, group);
    t.textContent = COUNTS[i];
    return { t, x: 128 * Math.sin(mid), y: -128 * Math.cos(mid) + 1.5 };
  });
  const dirLeft = el("text", { class: "main-wheel-dir", x: -8, y: -139, "text-anchor": "end" }, wheel);
  dirLeft.textContent = "← fourths";
  const dirRight = el("text", { class: "main-wheel-dir", x: 8, y: -139, "text-anchor": "start" }, wheel);
  dirRight.textContent = "fifths →";
  el("circle", { r: 33, class: "main-wheel-hub" }, wheel);
  const hubKey = el("text", { class: "main-wheel-hub-key", "text-anchor": "middle", y: -2 }, wheel);
  const hubSig = el("text", { class: "main-wheel-hub-sig", "text-anchor": "middle", y: 10 }, wheel);

  // ---------- type chips ----------
  const chipBox = $("main-wheel-types");
  const chips = {};
  types.forEach((t) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "main-wheel-chip";
    b.textContent = t.symbol || "maj";
    b.title = t.label;
    b.addEventListener("click", () => choose(rootPc(), t.key));
    chipBox.appendChild(b);
    chips[t.key] = b;
  });

  function rootPc() { return SHARP.indexOf(rootInput.value); }
  function typeOf(key) { return types.find((t) => t.key === key) || types[0]; }
  const chordName = (pc, q) => FLAT[pc] + (typeOf(q).symbol || "");

  function paintWheel() {
    const pc = rootPc(), q = typeInput.value;
    const ctx = context(pc, q);
    const minor = ctx.minor;
    const rel = relations(ctx.keyMajor, minor);
    const mode = modeSelect.value;
    const info = keyInfo(ctx.keyMajor, minor);
    hubKey.textContent = info.name;
    hubSig.textContent = info.acc;
    const keyIdx = MAJORS.indexOf(ctx.keyMajor);
    // the picked chord's own cell: the same position as its key, in whichever ring it lives
    const selIdx = keyIdx, selRing = ctx.ring;
    const a1 = ((keyIdx - 1.5) * 30 * Math.PI) / 180, a2 = ((keyIdx + 1.5) * 30 * Math.PI) / 180;
    outline.setAttribute("d", arc(35, 119, a1, a2));
    cells.forEach((c) => {
      const r = rel[c.ring + c.idx];
      const isSel = c.ring === selRing && c.idx === selIdx;
      c.g.classList.toggle("is-active", isSel);
      c.g.classList.toggle("is-near", !isSel && !!r && r.strong);
      c.g.classList.toggle("is-far", !isSel && !!r && !r.strong);
      c.g.classList.toggle("is-dim", !r);
      const alpha = c.ring === "outer" ? 0.5 : 0.4;
      let fill;
      if (isSel) fill = "#ff3b3b";
      else if (r) fill = "hsla(" + c.hue + "," + (r.strong ? 70 : 55) + "%," + (r.strong ? 46 : 38) + "%," + (r.strong ? 0.95 : 0.85) + ")";
      else fill = "hsla(" + c.hue + ",30%,24%," + alpha * 0.55 + ")";
      c.slice.style.fill = fill;
      c.sub.textContent = c.ring === "dim" ? "" : !r ? "" : mode === "degrees" ? r.degree : (isSel ? "chosen" : r.role.split(" ")[0]);
      c.title.textContent = c.name.textContent + (r ? ": " + r.role + " (" + r.degree + ") of " + info.name : ": not in " + info.name);
    });
    // the seven chords of the key, in order, with what to add to each
    relatedBox.textContent = "";
    const seven = diatonicSeven(ctx.keyMajor, minor);
    seven.forEach((d) => {
      const b = document.createElement("button");
      b.type = "button";
      const isCurrent = d.pc === pc && d.q === q;
      b.className = "main-wheel-related-chip" + (isCurrent ? " is-active" : "");
      const nm = FLAT[d.pc].replace("b", "♭") + (d.q === "min" ? "m" : d.q === "dim" ? "°" : "");
      b.innerHTML = '<span class="main-wheel-related-deg">' + d.deg + "</span><span>" + nm + '</span><span class="main-wheel-related-role">' + d.role + '</span><span class="main-wheel-related-hint">+ ' + d.hint + "</span>";
      b.addEventListener("click", () => choose(d.pc, d.q));
      relatedBox.appendChild(b);
    });
    applyRotation();
  }

  function applyRotation() {
    group.setAttribute("transform", "rotate(" + rotation + ")");
    cells.forEach((c) => {
      c.label.setAttribute("transform", "translate(" + c.x + " " + c.y + ") rotate(" + -rotation + ")");
    });
    countLabels.forEach((c) => c.t.setAttribute("transform", "translate(" + c.x + " " + c.y + ") rotate(" + -rotation + ")"));
  }

  rotateInput.addEventListener("input", () => {
    rotation = Number(rotateInput.value);
    rotateOut.textContent = rotation + "°";
    applyRotation();
  });
  modeSelect.addEventListener("change", paintWheel);
  audioButton.addEventListener("click", () => {
    audioOn = !audioOn;
    audioButton.setAttribute("aria-pressed", String(audioOn));
    audioButton.textContent = audioOn ? "🔊 Sound on" : "🔇 Sound off";
  });

  function refresh() {
    const pc = rootPc(), q = typeInput.value, t = typeOf(q);
    $("main-wheel-name").textContent = chordName(pc, q);
    $("main-wheel-label").textContent = t.label;
    Object.keys(chips).forEach((k) => chips[k].classList.toggle("is-active", k === q));
    paintWheel();
    chart.refresh();
  }

  function choose(pc, q) {
    rootInput.value = SHARP[pc];
    typeInput.value = q;
    refresh();
    wheel.dispatchEvent(new CustomEvent("main-chord-pick", { bubbles: true, detail: { play: audioOn } }));
  }

  // ---------- the chart: one type, every root, drawn on mini keyboards ----------
  const chart = (function () {
    const tabs = $("main-chart-tabs"), grid = $("main-chart-grid");
    let shown = "maj";
    const WHITE = [0, 2, 4, 5, 7, 9, 11], BLACKX = { 1: 0.7, 3: 1.7, 6: 3.7, 8: 4.7, 10: 5.7 };

    function keyboardSvg(pc, formula) {
      const notes = formula.map((s) => pc + s);
      const span = Math.max(...notes) >= 12 + 12 ? 3 : 2;       // octaves drawn
      const wCount = 7 * span, w = 10, h = 34;
      const svg = el("svg", { viewBox: `0 0 ${wCount * w} ${h}`, class: "main-chart-keys", "aria-hidden": "true" });
      const on = new Set(notes), rootNote = pc;
      for (let n = 0; n < 12 * span; n++) {
        const oct = Math.floor(n / 12), p = n % 12;
        if (WHITE.includes(p)) {
          const x = (oct * 7 + WHITE.indexOf(p)) * w;
          el("rect", { x, y: 0, width: w, height: h, class: "main-chart-white" + (on.has(n) ? (n === rootNote ? " is-root" : " is-on") : "") }, svg);
        }
      }
      for (let n = 0; n < 12 * span; n++) {
        const oct = Math.floor(n / 12), p = n % 12;
        if (BLACKX[p] !== undefined) {
          el("rect", { x: (oct * 7 + BLACKX[p]) * w, y: 0, width: w * 0.6, height: h * 0.6, class: "main-chart-black" + (on.has(n) ? (n === rootNote ? " is-root" : " is-on") : "") }, svg);
        }
      }
      return svg;
    }

    function draw() {
      grid.textContent = "";
      const t = typeOf(shown);
      for (let pc = 0; pc < 12; pc++) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "main-chart-card";
        const title = document.createElement("span");
        title.className = "main-chart-name";
        title.textContent = FLAT[pc] + t.symbol;
        card.appendChild(title);
        card.appendChild(keyboardSvg(pc, t.formula));
        card.addEventListener("click", () => choose(pc, shown));
        card.classList.toggle("is-active", rootPc() === pc && typeInput.value === shown);
        grid.appendChild(card);
      }
    }

    types.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "main-chart-tab";
      b.setAttribute("role", "tab");
      b.textContent = t.symbol || "maj";
      b.title = t.label;
      b.addEventListener("click", () => { shown = t.key; draw(); mark(); });
      tabs.appendChild(b);
    });
    function mark() {
      [...tabs.children].forEach((b, i) => b.classList.toggle("is-active", types[i].key === shown));
    }
    return { refresh() { shown = typeInput.value; draw(); mark(); } };
  })();

  refresh();
})();
