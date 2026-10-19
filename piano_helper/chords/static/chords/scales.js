// Scales section of the Learn page: pick a scale, see it on the page keyboard and a staff,
// hear it, and find the chords it makes. The key comes from the Key menu at the top of the page.
(function () {
  "use strict";
  const K = window.PianoKit;
  const dataEl = document.getElementById("scales-data");
  if (!K || !dataEl) return;
  const data = JSON.parse(dataEl.textContent);
  const $ = (id) => document.getElementById(id);
  const keySelect = $("learn-key-select");
  const board = K.createKeyboard($("main-keyboard-keys"), document.querySelector(".main-keyboard-case"));

  const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const SHARP = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const FLAT = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
  const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
  const byId = {};
  data.scales.forEach((s) => { byId[s.id] = s; });
  let current = byId.major;
  let active = false; // the Scales tab is showing

  // ---------- the key ----------
  // The menu value is a name like "C#" or "Db": which spelling you pick decides how notes are written.
  function keyInfo() {
    const raw = keySelect.value || "C";
    const letterIdx = LETTERS.indexOf(raw[0]);
    const flat = raw.length > 1 && raw[1] === "b";
    const sharp = raw.length > 1 && raw[1] === "#";
    const pc = (LETTER_PC[letterIdx] + (flat ? -1 : sharp ? 1 : 0) + 12) % 12;
    const label = LETTERS[letterIdx] + (flat ? "♭" : sharp ? "♯" : "");
    // F major has a B♭, so F reads with flats even though it has no accidental of its own
    return { pc, letterIdx, flat: flat || raw === "F", label };
  }
  function acc(n) { return n === 0 ? "" : n === 1 ? "♯" : n === -1 ? "♭" : n === 2 ? "𝄪" : n === -2 ? "𝄫" : (n > 0 ? "♯" : "♭"); }

  // names + staff letter positions for each note, spelled from the chosen root
  function spell(steps) {
    const k = keyInfo();
    const hepta = steps.length === 7;
    return steps.map((st, i) => {
      const pc = (k.pc + st) % 12;
      if (hepta) {
        const li = (k.letterIdx + i) % 7;
        let diff = pc - LETTER_PC[li];
        if (diff > 6) diff -= 12;
        if (diff < -6) diff += 12;
        return { name: LETTERS[li] + acc(diff), letter: k.letterIdx + i, pc, st };
      }
      const name = (k.flat ? FLAT : SHARP)[pc];
      // the staff letter: the natural note below (sharps) or above (flats)
      const natural = LETTER_PC.indexOf(pc) >= 0 ? pc : (k.flat ? (pc + 1) % 12 : (pc + 11) % 12);
      const li = LETTER_PC.indexOf(natural);
      const octave = Math.floor((k.pc + st) / 12);
      return { name, letter: li + 7 * octave, pc, st };
    });
  }
  const midiOf = (st) => 60 + keyInfo().pc + st;

  // ---------- the page keyboard ----------
  function showOnKeyboard() {
    const k = keyInfo();
    const inScale = new Set(current.steps.map((s) => (k.pc + s) % 12));
    const keys = [];
    for (let m = 24; m <= 108; m++) if (inScale.has(m % 12)) keys.push(m);
    board.mark(keys);
    paintRoot();
  }
  function paintRoot() {
    const k = keyInfo();
    document.querySelectorAll(".main-keyboard-key").forEach((el) => {
      el.classList.toggle("is-scale-root", active && Number(el.dataset.midi) % 12 === k.pc);
    });
  }
  function clearKeyboard() {
    board.mark([]);
    document.querySelectorAll(".is-scale-root").forEach((el) => el.classList.remove("is-scale-root"));
  }
  board.onRange(() => { if (active) { board.mark(markedList()); paintRoot(); } });
  function markedList() {
    const k = keyInfo();
    const inScale = new Set(current.steps.map((s) => (k.pc + s) % 12));
    const keys = [];
    for (let m = 24; m <= 108; m++) if (inScale.has(m % 12)) keys.push(m);
    return keys;
  }

  // ---------- staff ----------
  function drawStaff(notes) {
    const svg = $("scales-staff");
    const W = 640, left = 40, top = 30, gap = 12;
    const bottom = top + gap * 4; // the E4 line
    const E4 = 2 + 7 * 4;
    let out = "";
    for (let i = 0; i < 5; i++) out += `<line x1="10" x2="${W - 10}" y1="${top + i * gap}" y2="${top + i * gap}" class="scales-staff-line"/>`;
    const list = notes.concat([{ ...notes[0], letter: notes[0].letter + 7, octaveRoot: true }]);
    const span = (W - left - 30) / list.length;
    list.forEach((n, i) => {
      const idx = n.letter + 28;
      const y = bottom - (idx - E4) * gap / 2;
      const x = left + 20 + i * span;
      const ledger = (l) => `<line x1="${x - 11}" x2="${x + 11}" y1="${bottom - (l - E4) * gap / 2}" y2="${bottom - (l - E4) * gap / 2}" class="scales-staff-line"/>`;
      for (let l = 28; l >= idx; l -= 2) out += ledger(l);
      for (let l = 40; l <= idx; l += 2) out += ledger(l);
      const isRoot = i === 0 || i === list.length - 1;
      out += `<ellipse cx="${x}" cy="${y}" rx="6.5" ry="5" class="scales-staff-note${isRoot ? " is-root" : ""}" transform="rotate(-18 ${x} ${y})"/>`;
      if (/[♯♭𝄪𝄫]/.test(n.name)) out += `<text x="${x - 17}" y="${y + 5}" class="scales-staff-acc" text-anchor="middle">${n.name.slice(1)}</text>`;
      out += `<text x="${x}" y="${bottom + 40}" class="scales-staff-name" text-anchor="middle">${n.name}</text>`;
    });
    svg.innerHTML = out;
  }

  // ---------- sound ----------
  function play(down) {
    const sc = current;
    let list;
    if (down) {
      const steps = sc.descending || sc.steps;
      list = steps.map(midiOf).concat([midiOf(12)]).reverse();
    } else {
      list = sc.steps.map(midiOf).concat([midiOf(12)]);
    }
    K.stopAll();
    board.schedule(list.map((m, i) => ({ t: i * 0.32, midi: [m], dur: 0.6 })));
  }

  // ---------- chords ----------
  function diatonic(scale, notes) {
    const st = scale.steps;
    if (st.length !== 7) return [];
    const out = [];
    for (let i = 0; i < 7; i++) {
      const r = st[i];
      const t = (st[(i + 2) % 7] - r + 12) % 12;
      const f = (st[(i + 4) % 7] - r + 12) % 12;
      const diff = st[i] - MAJOR[i];
      const pre = diff < 0 ? "♭" : diff > 0 ? "♯" : "";
      let q, sym, label;
      if (t === 4 && f === 7) { q = "major"; sym = pre + ROMAN[i]; label = notes[i].name; }
      else if (t === 3 && f === 7) { q = "minor"; sym = pre + ROMAN[i].toLowerCase(); label = notes[i].name + "m"; }
      else if (t === 3 && f === 6) { q = "dim"; sym = pre + ROMAN[i].toLowerCase() + "°"; label = notes[i].name + "°"; }
      else if (t === 4 && f === 8) { q = "aug"; sym = pre + ROMAN[i] + "+"; label = notes[i].name + "+"; }
      else { q = "other"; sym = pre + ROMAN[i]; label = notes[i].name + " (?)"; }
      out.push({ i, q, sym, label, midi: [r, r + t, r + f].map(midiOf), fn: [0, 2, 5].includes(i) ? "T" : [1, 3].includes(i) ? "S" : "D" });
    }
    return out;
  }
  function renderChords(chords) {
    const wrap = $("scales-chords");
    wrap.innerHTML = "";
    $("scales-chords-block").hidden = chords.length === 0;
    chords.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "scales-chord is-" + c.q;
      b.innerHTML = `<span class="scales-chord-roman">${c.sym}</span><span class="scales-chord-name">${c.label}</span>`;
      b.addEventListener("click", () => { K.stopAll(); board.schedule([{ t: 0, midi: c.midi, dur: 1.6 }]); });
      wrap.appendChild(b);
    });
  }

  // ---------- cards ----------
  function buildGroups() {
    const host = $("scales-groups");
    host.innerHTML = "";
    data.groups.forEach((g) => {
      const sec = document.createElement("section");
      sec.className = "scales-section";
      sec.id = "group-" + g.id;
      sec.innerHTML = `<h2 class="scales-heading">${g.title}</h2><p class="scales-note">${g.intro}</p><div class="scales-card-grid"></div>`;
      const grid = sec.querySelector(".scales-card-grid");
      data.scales.filter((s) => s.group === g.id).forEach((s) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "scales-card";
        b.dataset.id = s.id;
        b.innerHTML = `<span class="scales-card-name">${s.name}</span><span class="scales-card-meta">${s.steps.length} notes · ${s.pattern}</span>`;
        b.addEventListener("click", () => { select(s.id); $("scales-detail").scrollIntoView({ behavior: "smooth", block: "start" }); });
        grid.appendChild(b);
      });
      host.appendChild(sec);
    });
  }

  function select(id) {
    current = byId[id] || current;
    K.stopAll();
    document.querySelectorAll(".scales-card").forEach((c) => c.classList.toggle("is-active", c.dataset.id === current.id));
    render();
    if (active) { try { history.replaceState(null, "", "?scale=" + current.id + "#scales"); } catch (error) { /* ignore */ } }
  }

  function render() {
    const sc = current;
    const k = keyInfo();
    const notes = spell(sc.steps);
    $("scales-title").textContent = k.label + " " + sc.name;
    $("scales-character").textContent = sc.character;
    $("scales-notes").textContent = notes.map((n) => n.name).join("  ") + (sc.descending ? "   (down: " + spell(sc.descending).map((n) => n.name).join(" ") + ")" : "");
    $("scales-pattern").textContent = sc.pattern + "   (W whole, H half, W+H a step and a half)";
    $("scales-trans").textContent = sc.transpositions === 12 ? "12 (one for every root)" : sc.transpositions + " (it repeats, so only " + sc.transpositions + " different sets of notes exist)";
    const sym = $("scales-symmetry");
    if (sc.transpositions < 12) {
      sym.hidden = false;
      sym.textContent = "Symmetrical: its pattern repeats inside the octave, so shifting it up by " + sc.transpositions + " semitone" + (sc.transpositions > 1 ? "s" : "") + " gives the same notes. No single note acts as home.";
    } else sym.hidden = true;
    drawStaff(notes);
    const chords = diatonic(sc, notes);
    renderChords(chords);
    const studio = $("scales-studio");
    studio.href = studio.dataset.base + "?scale=" + encodeURIComponent(sc.name) + "&key=" + k.pc;
    renderCompare();
    renderTonic(sc, notes, chords);
    if (active) showOnKeyboard();
  }

  function renderCompare() {
    const host = $("scales-compare");
    host.innerHTML = "";
    data.modeOrder.forEach((id) => {
      const s = byId[id];
      const notes = spell(s.steps);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "scales-compare-row" + (s.id === current.id ? " is-active" : "");
      row.innerHTML = `<span class="scales-compare-name">${s.name}</span><span class="scales-compare-notes">${notes.map((n, i) => `<span class="${s.steps[i] !== MAJOR[i] ? "is-changed" : ""}">${n.name}</span>`).join("")}</span>`;
      row.addEventListener("click", () => select(s.id));
      host.appendChild(row);
    });
  }

  function renderTonic(sc, notes, chords) {
    const host = $("scales-tonic-live");
    const rn = notes[0].name;
    let html = `<h3 class="scales-subheading">In ${rn} ${sc.name}</h3><p>Tonic note: <strong>${rn}</strong></p>`;
    if (chords.length) {
      html += `<p>Tonic chord: <strong>${chords[0].label}</strong></p><div class="scales-fn-row">`;
      chords.forEach((c) => { html += `<span class="scales-fn is-${c.fn}"><b>${c.sym}</b> ${c.label}<small>${c.fn}</small></span>`; });
      html += "</div>";
      const rel = relatives(sc, notes);
      if (rel) html += `<p>${rel}</p>`;
    } else if (sc.transpositions < 12) {
      html += `<p>This scale is symmetrical, so ${rn} is only the note you chose to start on. Any note of it could take that job.</p>`;
    } else {
      html += `<p>Tonic chord: <strong>${rn}</strong>, in whichever colour you like.</p>`;
    }
    host.innerHTML = html;
  }

  function relatives(sc, notes) {
    const k = keyInfo();
    const nameOf = (scaleId, pc) => {
      const flat = k.flat;
      return (flat ? FLAT : SHARP)[pc];
    };
    if (sc.id === "major") return `Relative minor: <strong>${nameOf("", (k.pc + 9) % 12)} minor</strong> (same notes). Parallel minor: <strong>${notes[0].name} minor</strong> (same tonic).`;
    if (sc.id === "natural-minor") return `Relative major: <strong>${nameOf("", (k.pc + 3) % 12)} major</strong> (same notes). Parallel major: <strong>${notes[0].name} major</strong> (same tonic).`;
    return "";
  }

  // ---------- wiring ----------
  function init() {
    const studio = $("scales-studio");
    studio.dataset.base = studio.getAttribute("href");
    buildGroups();
    const q = new URLSearchParams(location.search);
    const wantKey = q.get("key");
    if (wantKey !== null) {
      const opt = Array.from(keySelect.options).find((o) => o.value === wantKey) ||
        (/^\d+$/.test(wantKey) ? Array.from(keySelect.options).find((o) => { const prev = keySelect.value; keySelect.value = o.value; const hit = keyInfo().pc === Number(wantKey) % 12; keySelect.value = prev; return hit; }) : null);
      if (opt) keySelect.value = opt.value;
    }
    keySelect.addEventListener("change", () => render());
    $("scales-play").addEventListener("click", () => play(false));
    $("scales-play-down").addEventListener("click", () => play(true));
    select(byId[q.get("scale")] ? q.get("scale") : "major");
  }

  document.addEventListener("tabs:change", (event) => {
    const was = active;
    active = event.detail.name === "scales";
    if (active) showOnKeyboard();
    else if (was) clearKeyboard();
  });
  init();
  // the tabs script may have run before this one
  const sel = document.querySelector('[data-tabs] [aria-selected="true"]');
  if (sel && sel.dataset.tab === "scales") { active = true; showOnKeyboard(); }
})();
