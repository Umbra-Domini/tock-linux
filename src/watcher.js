"use strict";
// Idle watcher: works out how long the user has been idle and starts the screensaver.
// No Electron code in here on purpose, so it can be tested on its own.
const { execFile, spawn } = require("child_process");

const run = (cmd, args, timeout = 1500) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, out) => (err ? reject(err) : resolve(out))));

/* ---------- idle time providers: each one returns "ms since last input" ---------- */

// reads a number out of a `gdbus call` reply like "(uint64 12345,)"
function gdbusNumber(dest, obj, method) {
  return async () => {
    const out = await run("gdbus", ["call", "--session", "--dest", dest, "--object-path", obj, "--method", method]);
    const m = out.match(/uint\d+ (\d+)/) || out.match(/\((\d+)/);
    if (!m) throw new Error("unexpected reply: " + out.trim());
    return Number(m[1]);
  };
}

// GNOME only: true if a video player or similar has asked for the screen to stay awake
async function gnomeInhibited() {
  try {
    const out = await run("gdbus", ["call", "--session", "--dest", "org.gnome.SessionManager",
      "--object-path", "/org/gnome/SessionManager", "--method", "org.gnome.SessionManager.IsInhibited", "8"]);
    return out.includes("true");
  } catch {
    return false;   // anything odd: do not block the screensaver
  }
}

// Sway, Hyprland and other Wayland compositors: swayidle tells us when the idle timeout passes.
// It works on timeouts instead of a clock, so it is restarted whenever the delay changes.
function swayidleProvider() {
  let child = null, idle = false, secs = 0;
  const stop = () => {
    if (child) { child.removeAllListeners(); child.kill(); child = null; }
  };
  const begin = () => {
    stop();
    idle = false;
    const c = spawn("swayidle", ["timeout", String(secs), "echo IDLE", "resume", "echo ACTIVE"],
      { stdio: ["ignore", "pipe", "ignore"] });
    child = c;
    c.stdout.on("data", d => {
      for (const line of String(d).split("\n")) {
        if (line.trim() === "IDLE") idle = true;
        else if (line.trim() === "ACTIVE") idle = false;
      }
    });
    c.on("error", () => { if (child === c) child = null; });
    c.on("exit", () => { if (child === c) child = null; });
  };
  return {
    name: "swayidle",
    setDelay(s) {
      s = Math.max(1, Math.round(s));
      if (s !== secs || !child) { secs = s; begin(); }
    },
    get: async () => {
      if (!child) throw new Error("swayidle is not running");
      return idle ? Infinity : 0;
    },
    stop
  };
}

async function probeSwayidle() {
  try { await run("sh", ["-c", "command -v swayidle"]); } catch { return null; }
  const p = swayidleProvider();
  p.setDelay(60);
  await new Promise(r => setTimeout(r, 700));      // gives it time to fail if the compositor is unsupported
  try { await p.get(); return p; } catch { p.stop(); return null; }
}

// tries each method once and keeps the first that answers
async function detect({ env = process.env, electronIdleMs } = {}) {
  const tries = [
    ["gnome-mutter", gdbusNumber("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core",
      "org.gnome.Mutter.IdleMonitor.GetIdletime")]
  ];
  // Electron's own idle check only works on X11 (on Wayland it always says 0)
  if (electronIdleMs && env.XDG_SESSION_TYPE === "x11") tries.push(["x11", async () => electronIdleMs()]);
  tries.push(["kde", gdbusNumber("org.freedesktop.ScreenSaver", "/ScreenSaver",
    "org.freedesktop.ScreenSaver.GetSessionIdleTime")]);

  for (const [name, get] of tries) {
    try {
      const v = await get();
      if (Number.isFinite(v) && v >= 0) return { name, get };
    } catch {}
  }
  if (env.XDG_SESSION_TYPE === "wayland") return probeSwayidle();
  return null;
}

/* ---------- the watcher ---------- */
// getSettings() -> { enabled, delaySecs }     launch() -> child process of the screensaver
function createWatcher({ env = process.env, log = () => {}, getSettings, electronIdleMs, launch,
                         onDisabled = () => {}, provider = null, isInhibited = gnomeInhibited, pollMs = 2000 }) {
  let child = null, armed = true, timer = null, stopped = false, lastNote = "";

  const note = msg => { if (msg !== lastNote) { lastNote = msg; log(msg); } };   // log a repeating problem once
  const stopChild = () => { if (child) { try { child.kill(); } catch {} } };
  const shutdown = () => {
    stopped = true;
    clearTimeout(timer);
    stopChild();
    if (provider && provider.stop) provider.stop();
  };

  function startScreensaver() {
    armed = false;       // will not start again until the user has been active
    lastNote = "";
    log("idle long enough, starting the screensaver");
    const c = launch();
    child = c;
    c.on("error", e => { log("could not start the screensaver: " + e.message); if (child === c) child = null; });
    c.on("exit", code => { log("screensaver closed (exit " + code + ")"); if (child === c) child = null; });
  }

  // returns false when the watcher should stop
  async function tick() {
    const s = getSettings();
    if (!s.enabled) {
      log("screensaver is off, stopping the watcher");
      shutdown();
      onDisabled();
      return false;
    }
    if (!provider) {
      provider = await detect({ env, electronIdleMs });
      if (!provider) { note("no way to read idle time found on this desktop, will keep trying"); return true; }
      log("reading idle time with: " + provider.name);
    }
    const delayMs = s.delaySecs * 1000;
    if (provider.setDelay) provider.setDelay(s.delaySecs);

    let idle;
    try { idle = await provider.get(); }
    catch (e) { note("could not read idle time: " + e.message); return true; }

    if (child) {
      // any input resets idle time, so this also closes it if the window never got keyboard focus
      if (idle < delayMs) { log("activity seen, closing the screensaver"); stopChild(); }
      return true;
    }
    if (idle < delayMs) { armed = true; lastNote = ""; return true; }
    if (!armed) return true;
    if (await isInhibited()) { note("something is asking for the screen to stay awake (a video player, for example), not starting"); return true; }
    startScreensaver();
    return true;
  }

  async function loop() {
    if (stopped) return;
    let again = true;
    try { again = await tick(); } catch (e) { log("watcher error: " + e.message); }
    if (again && !stopped) timer = setTimeout(loop, pollMs);
  }

  return { tick, start: loop, stop: shutdown };
}

module.exports = { createWatcher, detect, gnomeInhibited };