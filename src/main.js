const { app, BrowserWindow, ipcMain, powerSaveBlocker, powerMonitor, screen } = require("electron");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWatcher } = require("./watcher");

// tock                = the settings app
// tock --screensaver  = fullscreen on every monitor, quits on any input
// tock --watch        = invisible idle watcher that starts the screensaver (runs at login)
const SCREENSAVER = process.argv.includes("--screensaver");
const WATCH = process.argv.includes("--watch");

// the settings app, the watcher and the screensaver each get their own browser profile folder,
// so their single-instance locks never collide. Settings and logs stay in dataDir.
const dataDir = app.getPath("userData");
if (WATCH || SCREENSAVER) {
  const own = path.join(dataDir, SCREENSAVER ? "screensaver-profile" : "watcher-profile");
  fs.mkdirSync(own, { recursive: true });
  app.setPath("userData", own);
}
if (WATCH) app.disableHardwareAcceleration();   // the watcher has no window, so no GPU process needed

const gotLock = !(WATCH || SCREENSAVER) || app.requestSingleInstanceLock();   // never two watchers or two screensavers
if (!gotLock) app.quit();

const webPreferences = {
  preload: path.join(__dirname, "preload.js"),
  autoplayPolicy: "no-user-gesture-required"
};

/* ---------- saved settings: { clock, screensaver: { enabled, delaySecs } } ---------- */
const settingsFile = path.join(dataDir, "settings.json");
const SS_DEFAULT = { enabled: false, delaySecs: 120 };

function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    return { clock: s.clock || null, screensaver: { ...SS_DEFAULT, ...(s.screensaver || {}) } };
  } catch {
    return { clock: null, screensaver: { ...SS_DEFAULT } };
  }
}

function writeSettings(patch = {}) {
  const cur = readSettings();
  const next = {
    clock: patch.clock || cur.clock,
    screensaver: { ...cur.screensaver, ...(patch.screensaver || {}) }
  };
  // write then rename, so the watcher never reads a half-written file
  const tmp = settingsFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, settingsFile);
  return next;
}

/* ---------- starting this same app in another mode ---------- */
function selfCommand(extra) {
  const noSandbox = process.argv.includes("--no-sandbox");
  if (process.env.APPIMAGE) return { cmd: process.env.APPIMAGE, args: ["--no-sandbox", ...extra] };   // AppImages cannot use the setuid sandbox
  if (!app.isPackaged) return { cmd: process.execPath, args: [app.getAppPath(), ...(noSandbox ? ["--no-sandbox"] : []), ...extra] };
  return { cmd: process.execPath, args: [...(noSandbox ? ["--no-sandbox"] : []), ...extra] };
}

/* ---------- starting the screensaver as its own process ---------- */
// On Wayland an app cannot choose which monitor a window opens on, so with two monitors both clocks can
// land on one screen. Running the screensaver through XWayland lets us place one window per monitor.
// If that fails to start quickly (no XWayland), it is started again the normal way.
function launchScreensaver(extra = []) {
  const out = new EventEmitter();
  const viaX11 = process.env.XDG_SESSION_TYPE === "wayland";
  let cur = null, killed = false;

  const run = useX11 => {
    const { cmd, args } = selfCommand(["--screensaver", ...extra, ...(useX11 ? ["--ozone-platform=x11"] : [])]);
    const started = Date.now();
    cur = spawn(cmd, args, { stdio: "ignore" });
    cur.on("error", e => out.emit("error", e));
    cur.on("exit", code => {
      if (useX11 && !killed && code !== 0 && Date.now() - started < 3000) return run(false);
      out.emit("exit", code);
    });
  };
  out.kill = () => { killed = true; if (cur) { try { cur.kill(); } catch {} } };
  run(viaX11);
  return out;
}

/* ---------- login entry + watcher process (used by Save and Turn off) ---------- */
const autostartFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "autostart", "tock-screensaver.desktop");

// quoting rules of the .desktop Exec key
const quoteArg = s => /^[A-Za-z0-9_\/.:=+@,-]+$/.test(s)
  ? s
  : '"' + s.replace(/\\/g, "\\\\\\\\").replace(/(["`$])/g, "\\$1").replace(/%/g, "%%") + '"';

function setAutostart(on) {
  try {
    if (!on) { fs.rmSync(autostartFile, { force: true }); return; }
    const { cmd, args } = selfCommand(["--watch"]);
    fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
    fs.writeFileSync(autostartFile, [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Tock screensaver",
      "Comment=Starts the Tock screensaver when you are idle",
      `TryExec=${cmd}`,                                  // desktops skip the entry if Tock was uninstalled
      `Exec=${[cmd, ...args].map(quoteArg).join(" ")}`,
      "Terminal=false",
      "NoDisplay=true",
      "X-GNOME-Autostart-enabled=true",
      ""
    ].join("\n"));
  } catch (err) {
    console.error("autostart:", err.message);
  }
}

// if a watcher is already running the new one quits straight away (single-instance lock)
function startWatcher() {
  try {
    const { cmd, args } = selfCommand(["--watch"]);
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", err => console.error("watcher:", err.message));
    child.unref();
  } catch (err) {
    console.error("watcher:", err.message);
  }
}

function applyScreensaver(enabled) {
  setAutostart(enabled);
  if (enabled) startWatcher();   // when turned off, the watcher notices on its own within a few seconds
}

/* ---------- normal app window (remembers size, position, fullscreen) ---------- */
const stateFile = path.join(dataDir, "window-state.json");

function loadState() {
  try { return { width: 1000, height: 600, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; }
  catch { return { width: 1000, height: 600 }; }
}

// only reuse the saved position if it is still on a connected display
function onScreen(s) {
  if (typeof s.x !== "number" || typeof s.y !== "number") return false;
  return screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return s.x < a.x + a.width && s.x + s.width > a.x && s.y < a.y + a.height && s.y + s.height > a.y;
  });
}

function createWindow() {
  const state = loadState();
  const opts = {
    width: state.width,
    height: state.height,
    show: false,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    title: "Tock",
    webPreferences
  };
  if (onScreen(state)) { opts.x = state.x; opts.y = state.y; }

  const win = new BrowserWindow(opts);
  if (state.maximized) win.maximize();
  win.loadFile("clock/index.html");
  win.once("ready-to-show", () => {
    win.show();
    if (state.fullscreen) win.setFullScreen(true);
  });

  let timer;
  const save = () => {
    if (win.isDestroyed()) return;
    try {
      const b = win.getNormalBounds();   // the windowed size, even while fullscreen
      fs.writeFileSync(stateFile, JSON.stringify({
        ...b, fullscreen: win.isFullScreen(), maximized: win.isMaximized()
      }));
    } catch {}
  };
  const saveSoon = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]
    .forEach(e => win.on(e, saveSoon));
  win.on("close", save);

  // keep the screen awake only while the clock window is fullscreen (used as a real clock).
  // A normal settings window must not block the screensaver.
  let blockerId = null;
  const syncBlocker = () => {
    if (win.isFullScreen() && blockerId === null) blockerId = powerSaveBlocker.start("prevent-display-sleep");
    else if (!win.isFullScreen() && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  };
  win.on("enter-full-screen", syncBlocker);
  win.on("leave-full-screen", syncBlocker);

  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });
}

/* ---------- screensaver: one fullscreen clock per monitor ---------- */
function createScreensaverWindows(extra = {}) {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map(d => {
    const win = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      frame: false,
      fullscreen: true,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: "#000000",
      title: "Tock",
      webPreferences
    });
    win.setAlwaysOnTop(true, "screen-saver");
    // only the primary monitor plays the flip sound
    win.loadFile("clock/index.html", { query: { mode: "screensaver", mute: d.id === primary ? "0" : "1", ...extra } });
    win.once("ready-to-show", () => win.show());
    return win;
  });
}

/* ---------- preview: a few seconds of the real screensaver, started as its own process ---------- */
let previewProc = null, previewTimer;
function closePreview() {
  clearTimeout(previewTimer);
  if (previewProc) { previewProc.kill(); previewProc = null; }
}

/* ---------- watcher mode: no window, just checks idle time ---------- */
function runWatcher() {
  const logFile = path.join(dataDir, "watcher.log");
  const log = msg => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    process.stdout.write(line);
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 100000) fs.writeFileSync(logFile, "");
      fs.appendFileSync(logFile, line);
    } catch {}
  };

  let last = { enabled: false, delaySecs: SS_DEFAULT.delaySecs };
  const getSettings = () => {
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, "utf8")).screensaver || {};
      last = { enabled: !!s.enabled, delaySecs: Math.min(7200, Math.max(10, Number(s.delaySecs) || SS_DEFAULT.delaySecs)) };
    } catch (e) {
      if (e.code === "ENOENT") last = { ...last, enabled: false };   // any other error: keep the last good values
    }
    return last;
  };

  log(`watcher started (${process.env.XDG_SESSION_TYPE || "unknown session"}, ${process.env.XDG_CURRENT_DESKTOP || "unknown desktop"})`);

  const watcher = createWatcher({
    log,
    getSettings,
    electronIdleMs: () => powerMonitor.getSystemIdleTime() * 1000,
    launch: () => launchScreensaver(),
    onDisabled: () => app.quit()
  });
  app.on("will-quit", () => watcher.stop());
  watcher.start();
}

app.whenReady().then(() => {
  if (!gotLock) return;

  if (WATCH) { runWatcher(); return; }

  ipcMain.on("get-settings", e => { e.returnValue = readSettings(); });
  ipcMain.handle("save-settings", (e, patch) => {
    const next = writeSettings(patch);
    applyScreensaver(next.screensaver.enabled);
    return next;
  });
  ipcMain.on("preview-screensaver", (e, draft) => {
    closePreview();
    const p = launchScreensaver(["--draft=" + String(draft).slice(0, 4000)]);
    previewProc = p;
    p.on("exit", () => { if (previewProc === p) previewProc = null; });
    previewTimer = setTimeout(closePreview, 6000);
  });
  // screensaver process: leaving quits the app; preview: just closes the preview windows
  ipcMain.on("quit", () => (SCREENSAVER ? app.quit() : closePreview()));

  if (SCREENSAVER) {
    const draftArg = process.argv.find(a => a.startsWith("--draft="));   // set by Preview: unsaved settings to show
    createScreensaverWindows(draftArg ? { draft: draftArg.slice("--draft=".length) } : {});   // no power-save blocker: the system may still blank the screen
  } else {
    createWindow();
    // after an update, a crash or a reboot: make sure the login entry and watcher are in place
    if (readSettings().screensaver.enabled) applyScreensaver(true);
  }
});
app.on("window-all-closed", () => app.quit());