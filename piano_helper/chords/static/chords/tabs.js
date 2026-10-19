// Sections inside one page. A group of buttons with role="tab" and data-tab="name" shows the panel
// with data-panel="name". The URL hash picks the section, so #scales, or any id inside a panel
// (like #dynamics), opens the right one. Old links to the Notation, Scales and Songs pages land here.
(function () {
  "use strict";
  const bar = document.querySelector("[data-tabs]");
  if (!bar) return;
  const tabs = Array.from(bar.querySelectorAll('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll("[data-panel]"));
  const names = tabs.map((t) => t.dataset.tab);

  function activate(name, remember) {
    if (names.indexOf(name) < 0) name = names[0];
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      t.classList.toggle("is-active", on);
    });
    panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (remember) {
      try { history.replaceState(null, "", location.pathname + location.search + "#" + name); } catch (error) { /* ignore */ }
    }
    document.dispatchEvent(new CustomEvent("tabs:change", { detail: { name } }));
  }

  function fromHash(scroll) {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!id) return false;
    if (names.indexOf(id) >= 0) { activate(id, false); return true; }
    const target = document.getElementById(id);
    const panel = target && target.closest("[data-panel]");
    if (!panel) return false;
    activate(panel.dataset.panel, false);
    if (scroll) requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
    return true;
  }

  tabs.forEach((t, i) => {
    t.addEventListener("click", () => activate(t.dataset.tab, true));
    t.addEventListener("keydown", (event) => {
      let to = -1;
      if (event.key === "ArrowRight") to = (i + 1) % tabs.length;
      else if (event.key === "ArrowLeft") to = (i - 1 + tabs.length) % tabs.length;
      if (to < 0) return;
      event.preventDefault();
      tabs[to].focus();
      activate(tabs[to].dataset.tab, true);
    });
  });
  window.addEventListener("hashchange", () => fromHash(true));
  if (!fromHash(true)) activate(names[0], false);
})();
