(() => {
  const $ = id => document.getElementById(id);

  /* screensaver mode: the app opens index.html?mode=screensaver (mute=1 on extra monitors) */
  const params = new URLSearchParams(location.search);
  const SS = params.get("mode") === "screensaver";
  const MUTE = params.get("mute") === "1";
  if (SS) document.documentElement.classList.add("screensaver");
  /* Electron app: settings live in a file owned by the app and only change when "Save" is pressed.
     Plain browser: no screensaver, so settings save to localStorage as you change them. */
  const APP = !!window.tock;
  if (!APP) document.documentElement.classList.add("web");
  const KEY = "tock-settings";
  const S = { h24: false, flaps: true, dim: 100, size: 100, sound: false, vol: 60, shift: true, ampm: "top", bg: true, delay: 2 };
  try {
    const fromApp = APP && window.tock.settings.clock;
    Object.assign(S, fromApp || JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch (e) {}
  let saved = JSON.stringify(S);                         // last saved settings
  let ss = APP ? Object.assign({ enabled: false, delaySecs: 120 }, window.tock.settings.screensaver) : null;
  const save = () => {                                   // web only; the app waits for the Save button
    if (APP) return;
    saved = JSON.stringify(S);
    try { localStorage.setItem(KEY, saved); } catch (e) {}
  };
  const draft = params.get("draft");                     // Preview: show the unsaved settings
  if (draft) { try { Object.assign(S, JSON.parse(draft)); } catch (e) {} }

  const FLIP_MS = 1600;
  const SOUND_DELAY = 0;      // ms after flip starts (≈ when the flap lands); tune to your wav

  /* ---------- sound ---------- */
  const snd = new Audio("../audio/flip.wav");
  snd.preload = "auto";
  function playFlip() {
    if (!S.sound || MUTE) return;
    setTimeout(() => {
      const a = snd.cloneNode();        // clone so quick successive flips can overlap
      a.volume = S.vol / 100;
      a.play().catch(() => {});         // ignored if the browser blocks autoplay
    }, SOUND_DELAY);
  }

  /* ---------- cards ---------- */
  function makeCard(parent) {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML =
      '<div class="half top"><span></span></div>' +
      '<div class="half bot"><span></span></div>' +
      '<div class="leaf">' +
        '<div class="face front"><span></span></div>' +
        '<div class="face back"><span></span></div>' +
      '</div>';
    parent.appendChild(el);
    const [top, bot, ft, fb] = el.querySelectorAll(".half span, .face span");
    return { el, top, bot, ft, fb, value: null, timer: 0 };
  }

  const cards = [
    makeCard($("hh")), makeCard($("hh")),
    makeCard($("mm")), makeCard($("mm"))
  ];

  function setDigit(c, v) {
    if (c.value === v) return false;
    const old = c.value;
    c.value = v;
    clearTimeout(c.timer);
    c.el.classList.remove("flip");

    if (old === null || !S.flaps) {
      [c.top, c.bot, c.ft, c.fb].forEach(s => (s.textContent = v));
      return false;
    }
    // static halves: top = new, bottom = old; flaps: front = old, back = new
    c.top.textContent = v;  c.bot.textContent = old;
    c.ft.textContent  = old; c.fb.textContent = v;
    void c.el.offsetWidth;                 // restart animation (works for rapid clicks)
    c.el.classList.add("flip");
    c.timer = setTimeout(() => {
      c.bot.textContent = v; c.ft.textContent = v;
      c.el.classList.remove("flip");
    }, FLIP_MS);
    return true;
  }

  /* ---------- time ---------- */
  function tick() {
    const d = new Date();
    let h = d.getHours();
    const m = d.getMinutes();
    $("ampm").textContent = S.h24 ? "" : (h >= 12 ? "PM" : "AM");
    if (!S.h24) h = h % 12 || 12;
    const hs = String(h).padStart(2, "0"), ms = String(m).padStart(2, "0");
    const first = (!S.h24 && hs[0] === "0") ? " " : hs[0];
    cards[0].el.classList.toggle("gone", first === " ");
    let flipped = false;
    [first, hs[1], ms[0], ms[1]].forEach((v, i) => { if (setDigit(cards[i], v)) flipped = true; });
    if (flipped) playFlip();     // always ONE sound per tick, however many cards flip
  }

  /* ---------- settings ---------- */
  function apply() {
    $("h24").checked = S.h24;
    $("flaps").checked = S.flaps;
    $("sound").checked = S.sound;
    $("vol").value = S.vol;
    $("dim").value = S.dim;
    $("size").value = S.size;
    $("shift").checked = S.shift;
    $("delay").value = S.delay;
    $("bg").checked = S.bg;
    document.body.classList.toggle("nobg", !S.bg);
    document.body.classList.toggle("ampm-bottom", S.ampm === "bottom");
    document.querySelectorAll("#ampmpos button").forEach(b => b.classList.toggle("on", b.dataset.v === S.ampm));
    $("ampmrow").classList.toggle("off", S.h24);          // no AM/PM label in 24-hour mode
    if (!S.shift) setShift(0, 0);
    $("vol").disabled = !S.sound;
    $("vol").closest(".row").classList.toggle("off", !S.sound);
    ["vol", "dim", "size", "delay"].forEach(id => {
      const r = $(id);
      r.style.setProperty("--pct", (r.value - r.min) / (r.max - r.min) * 100 + "%");
      $(id + "v").textContent = r.value + (id === "delay" ? " min" : "%");
    });
    $("clock").style.filter = "brightness(" + S.dim / 100 + ")";
    document.documentElement.style.setProperty("--scale", S.size / 100);
    document.body.classList.toggle("noflaps", !S.flaps);
    tick();
    renderStatus();
  }
  [["h24", "change", "checked"], ["flaps", "change", "checked"],
   ["dim", "input", "value"], ["size", "input", "value"],
   ["sound", "change", "checked"], ["vol", "input", "value"],
   ["shift", "change", "checked"], ["bg", "change", "checked"], ["delay", "input", "value"]].forEach(([id, ev, prop]) =>
    $(id).addEventListener(ev, e => {
      S[id] = prop === "checked" ? e.target.checked : +e.target.value;
      save(); apply();
      if (id === "shift" && S.shift) nudge();             // show the effect right away
    }));

  document.querySelectorAll("#ampmpos button").forEach(b =>
    b.addEventListener("click", () => { S.ampm = b.dataset.v; save(); apply(); }));

  /* ---------- tabs, save / discard, screensaver status ---------- */
  function renderStatus() {
    if (!APP) return;
    const dirty = JSON.stringify(S) !== saved, on = ss.enabled;
    $("status").textContent = dirty ? "Unsaved changes"
      : on ? "Screensaver on · starts after " + Math.round(ss.delaySecs / 60) + " min"
      : "Screensaver off";
    $("statusdot").className = "dot" + (dirty ? " dirty" : on ? " on" : "");
    $("discard").hidden = !dirty;
    $("off").disabled = !on;
  }
  document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("#tabs button").forEach(x => x.classList.toggle("on", x === b));
    $("pane-clock").hidden = b.dataset.t !== "clock";
    $("pane-ss").hidden = b.dataset.t !== "ss";
    hideTip();
  }));
  $("save").addEventListener("click", () => {
    saved = JSON.stringify(S);
    ss = { enabled: true, delaySecs: S.delay * 60 };
    if (APP) window.tock.save({ clock: S, screensaver: ss });
    renderStatus();
  });
  $("discard").addEventListener("click", () => { Object.assign(S, JSON.parse(saved)); apply(); });
  $("off").addEventListener("click", () => {
    ss = Object.assign({}, ss, { enabled: false });
    if (APP) window.tock.save({ screensaver: ss });
    renderStatus();
  });
  $("preview").addEventListener("click", () => {
    setMenu(false);
    if (APP) window.tock.preview(JSON.stringify(S));
  });

  /* ---------- burn-in protection: drift a few px every few minutes ---------- */
  const SHIFT_PX = 14, SHIFT_EVERY = 3 * 60 * 1000;
  function setShift(x, y) {
    $("clock").style.setProperty("--sx", x + "px");
    $("clock").style.setProperty("--sy", y + "px");
  }
  function nudge() {
    if (!S.shift) return;
    const r = () => Math.round((Math.random() * 2 - 1) * SHIFT_PX);
    setShift(r(), r());
  }
  setInterval(nudge, SHIFT_EVERY);

  /* settings menu */
  const isOpen = () => $("menu").classList.contains("open");
  function setMenu(open) {
    $("menu").classList.toggle("open", open);
    $("gear").setAttribute("aria-expanded", open);
    if (!open) hideTip();
    wake();
  }
  $("gear").addEventListener("click", () => setMenu(!isOpen()));
  document.addEventListener("click", e => { if (isOpen() && !$("menu").contains(e.target)) setMenu(false); });
  addEventListener("keydown", e => { if (e.key === "Escape" && isOpen()) setMenu(false); });

  /* info tooltips: one floating box, placed left of the panel */
  const tip = $("tip");
  function showTip(el) {
    tip.textContent = el.dataset.tip;
    tip.style.left = "0px"; tip.style.top = "0px";        // measure at natural width
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const r = el.getBoundingClientRect(), p = $("panel").getBoundingClientRect();
    let left = p.left - w - 10, top = r.top + r.height / 2 - h / 2;
    if (left < 8) {                                         // no room on the left: go under the icon
      left = Math.max(8, Math.min(p.left + 10, innerWidth - w - 8));
      top = r.bottom + 8;
      if (top + h > innerHeight - 8) top = r.top - h - 8;
    }
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    tip.style.left = left + "px"; tip.style.top = top + "px";
    tip.classList.add("show");
  }
  function hideTip() { tip.classList.remove("show"); }
  document.querySelectorAll(".info").forEach(el => {
    el.addEventListener("mouseenter", () => showTip(el));
    el.addEventListener("mouseleave", hideTip);
    el.addEventListener("focus", () => showTip(el));
    el.addEventListener("blur", hideTip);
    el.addEventListener("click", e => e.preventDefault());  // don't toggle the setting behind it
  });
  document.querySelector(".panes").addEventListener("scroll", hideTip);

  /* auto-hide controls (stay visible while the menu is open) */
  let hideTimer;
  function wake() {
    document.body.classList.add("active");
    clearTimeout(hideTimer);
    if (isOpen()) return;
    hideTimer = setTimeout(() => document.body.classList.remove("active"), 3000);
  }
  ["mousemove", "keydown", "touchstart", "click"].forEach(e => addEventListener(e, wake));

  /* screensaver: any key, click, scroll, touch or real mouse movement quits */
  if (SS) {
    const armed = Date.now() + 1000;               // ignore input right after launch
    const leave = () => (window.tock ? window.tock.quit() : window.close());
    ["keydown", "mousedown", "wheel", "touchstart"].forEach(ev =>
      addEventListener(ev, () => { if (Date.now() > armed) leave(); }, true));
    let last = null;
    addEventListener("mousemove", e => {
      const p = [e.screenX, e.screenY];
      if (Date.now() < armed || !last) { last = p; return; }
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) > 6) leave();
    }, true);
  }

  apply(); wake();
  setInterval(tick, 500);
})();