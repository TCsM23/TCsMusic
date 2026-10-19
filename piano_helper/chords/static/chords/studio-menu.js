(function () {
  "use strict";
  // the site menu slides in over the Studio so the page itself can use the whole screen
  const open = document.getElementById("studio-menu-open");
  const drawer = document.getElementById("studio-drawer");
  const shade = document.getElementById("studio-drawer-shade");
  if (!open || !drawer) return;

  function setOpen(on) {
    drawer.hidden = !on;
    open.setAttribute("aria-expanded", String(on));
    if (on) {
      const first = drawer.querySelector("a");
      if (first) first.focus();
    }
  }
  open.addEventListener("click", () => setOpen(drawer.hidden));
  shade.addEventListener("click", () => setOpen(false));
  // loaded before the Studio's own key handling, so Escape closes the menu first and does not also stop playback
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !drawer.hidden) { setOpen(false); event.stopImmediatePropagation(); event.preventDefault(); }
  }, true);
})();
