"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } = require("electron");

const { Backend } = require("./backend");
const config = require("./config");

const APP_NAME = "DB Backup & Restore";
app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId("com.dbbackup.desktop");

// Backend + built frontend: packaged → resources/app, development → db-backup-system-desktop/app.
const APP_ROOT = app.isPackaged ? path.join(process.resourcesPath, "app") : path.join(__dirname, "..", "app");
const RENDERER = path.join(__dirname, "..", "renderer");
const ICON = path.join(__dirname, "..", "build", "icon.png");
const LOG_DIR = path.join(app.getPath("userData"), "logs");

let settings = null;
let mainWindow = null;
let settingsWindow = null;
let appOrigin = null;
let generation = 0;
const backend = new Backend({ appRoot: APP_ROOT, logDir: LOG_DIR });

/** State shown on the startup screen. phase: setup | starting | waiting | error | ready */
let state = { phase: "starting", title: "Starting", message: "Starting the local backend…", detail: null, step: 0 };

const setState = (next) => {
  state = { ...state, detail: null, ...next };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("desktop:state", state);
};

/** True only for our own local pages (startup screen, settings) — never for the web app or anything remote. */
const isRendererUrl = (url) => {
  try {
    if (!String(url).startsWith("file:")) return false;
    const file = path.resolve(fileURLToPath(url)).toLowerCase();
    return file.startsWith(path.resolve(RENDERER).toLowerCase() + path.sep);
  } catch {
    return false;
  }
};
const fromRenderer = (event) => isRendererUrl(event.senderFrame?.url || "");

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

const restoreBounds = () => {
  const saved = settings?.window;
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(saved?.width ?? 1440, area.width);
  const height = Math.min(saved?.height ?? 920, area.height);
  const visible =
    saved && Number.isInteger(saved.x) && screen.getAllDisplays().some(({ bounds: b }) => saved.x >= b.x - 50 && saved.x < b.x + b.width && saved.y >= b.y - 50 && saved.y < b.y + b.height);
  return { width, height, ...(visible ? { x: saved.x, y: saved.y } : {}) };
};

const rememberBounds = () => {
  if (!mainWindow || mainWindow.isDestroyed() || !settings) return Promise.resolve();
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  settings.window = { ...bounds, maximized };
  return config.save(settings).catch(() => undefined); // not critical
};

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    ...restoreBounds(),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: "#0b0814",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Keep polling job progress (and the % in the title bar) while the window is minimized or behind others.
      backgroundThrottling: false,
    },
  });
  if (settings?.window?.maximized) mainWindow.maximize();

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", () => void rememberBounds());
  mainWindow.on("closed", () => (mainWindow = null));
  mainWindow.on("page-title-updated", (event, title) => {
    // Keep the app name in the title bar; the web app adds progress like "45% · Copying…".
    event.preventDefault();
    mainWindow.setTitle(title.includes("Copying") || title.startsWith("✓") || title.startsWith("✕") ? `${title.split(" — ")[0]} — ${APP_NAME}` : APP_NAME);
  });

  const contents = mainWindow.webContents;
  // Only our startup screen and the local app may load in this window; everything else opens in the browser.
  contents.on("will-navigate", (event, url) => {
    if (isRendererUrl(url) || (appOrigin && url.startsWith(`${appOrigin}/`))) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-fail-load", (_event, code, description, url) => {
    if (appOrigin && url.startsWith(appOrigin) && code !== -3) {
      setState({ phase: "error", title: "Could not open the app", message: `The window could not load ${url}: ${description}.`, step: 2 });
      showStartupScreen();
    }
  });
};

const showStartupScreen = () => {
  if (!mainWindow) return;
  const current = mainWindow.webContents.getURL();
  if (!isRendererUrl(current)) void mainWindow.loadFile(path.join(RENDERER, "splash.html"));
  else mainWindow.webContents.send("desktop:state", state);
};

const openSettings = () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 820,
    minWidth: 600,
    minHeight: 600,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    show: false,
    title: `Settings — ${APP_NAME}`,
    icon: ICON,
    backgroundColor: "#0b0814",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  settingsWindow.setMenu(null);
  settingsWindow.once("ready-to-show", () => settingsWindow.show());
  settingsWindow.on("closed", () => (settingsWindow = null));
  settingsWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  void settingsWindow.loadFile(path.join(RENDERER, "settings.html"));
};

/* ------------------------------------------------------------------ */
/* Backend lifecycle                                                   */
/* ------------------------------------------------------------------ */

const boot = async () => {
  const myGeneration = ++generation;
  const isCurrent = () => myGeneration === generation;
  appOrigin = null;
  settings = await config.load(APP_ROOT);
  showStartupScreen();

  if (!settings.db) {
    setState({
      phase: "setup",
      title: "Welcome",
      message: "Connect the app database to get started. It stores user accounts and history — use the same database as the website so both stay in sync.",
      step: -1,
    });
    openSettings();
    return;
  }

  setState({ phase: "starting", title: "Starting", message: "Starting the local backend…", step: 0 });
  try {
    await backend.stop();
    appOrigin = await backend.start(settings);
  } catch (error) {
    setState({ phase: "error", title: "Could not start", message: error.message, step: 0 });
    return;
  }
  if (!isCurrent()) return;

  setState({ phase: "starting", title: "Connecting", message: `Connecting to "${settings.db.name}" on ${settings.db.host}…`, step: 1 });
  const healthy = await backend.waitUntilHealthy((body) => {
    if (!isCurrent()) return;
    if (!body) return; // still starting
    setState({
      phase: body.startup_attempts > 1 ? "waiting" : "starting",
      title: body.startup_attempts > 1 ? "Waiting for the database" : "Connecting",
      message: body.startup_attempts > 1 ? "The app database is not ready yet. Retrying automatically…" : `Connecting to "${settings.db.name}" on ${settings.db.host}…`,
      detail: body.startup_attempts > 1 ? body.message : null,
      step: 1,
    });
  }, isCurrent);
  if (!healthy || !isCurrent()) return;

  setState({ phase: "ready", title: "Ready", message: "Opening the app…", step: 2 });
  await mainWindow?.loadURL(`${appOrigin}/`);
};

const restart = () => void boot();

backend.on("crash", ({ code, tail }) => {
  appOrigin = null;
  setState({
    phase: "error",
    title: "The backend stopped",
    message: `The local backend stopped unexpectedly${code !== null && code !== undefined ? ` (exit code ${code})` : ""}.`,
    detail: tail.slice(-12).join("\n") || null,
    step: 1,
  });
  showStartupScreen();
});

/* ------------------------------------------------------------------ */
/* Database test (settings window)                                     */
/* ------------------------------------------------------------------ */

const testDatabase = async (db) => {
  const normalised = config.normaliseDb(db);
  if (!normalised) return { ok: false, message: "Enter the host, database name and user name." };
  let pg;
  try {
    pg = require(path.join(APP_ROOT, "backend", "node_modules", "pg"));
  } catch {
    return { ok: false, message: 'The backend files are missing. Run "npm run build:app" in db-backup-system-desktop.' };
  }
  const client = new pg.Client({
    host: normalised.host,
    port: normalised.port,
    user: normalised.user,
    password: normalised.password,
    database: normalised.name,
    ssl: normalised.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10_000,
    application_name: "db-backup-desktop-settings",
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT current_setting('server_version') AS version,
              to_regclass('public.schema_migrations') IS NOT NULL AS has_migrations,
              to_regclass('public.users') IS NOT NULL AS has_users`
    );
    const info = rows[0];
    if (!info.has_migrations || !info.has_users) {
      return {
        ok: true,
        warning: true,
        message: `Connected (PostgreSQL ${info.version}), but this database has not been migrated yet. Run "npm run migrate" and "npm run seed" in db-backup-system-bakcend with these credentials, or pick the database the website uses.`,
      };
    }
    const users = await client.query(`SELECT count(*)::int AS count FROM users`);
    return { ok: true, message: `Connected to "${normalised.name}" (PostgreSQL ${info.version}) — ${users.rows[0].count} user account(s). Ready.` };
  } catch (error) {
    const message =
      error.code === "3D000"
        ? `The database "${normalised.name}" does not exist. Run "npm run migrate" in db-backup-system-bakcend with these credentials to create it.`
        : error.code === "28P01"
          ? "Wrong user name or password."
          : error.code === "ECONNREFUSED"
            ? `Nothing is listening on ${normalised.host}:${normalised.port}. Check the host and port, and that PostgreSQL is running.`
            : error.code === "ENOTFOUND"
              ? `The host "${normalised.host}" was not found.`
              : /SSL|ssl/.test(error.message)
                ? `${error.message}. Try switching "Use SSL" ${normalised.ssl ? "off" : "on"}.`
                : error.message;
    return { ok: false, message };
  } finally {
    await client.end().catch(() => undefined);
  }
};

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

const guard = (handler) => (event, ...args) => {
  if (!fromRenderer(event)) throw new Error("Not allowed");
  return handler(...args);
};

ipcMain.handle("desktop:getState", guard(() => state));
ipcMain.handle("desktop:retry", guard(() => restart()));
ipcMain.handle("desktop:openSettings", guard(() => openSettings()));
ipcMain.handle("desktop:openLogs", guard(() => shell.openPath(LOG_DIR)));

ipcMain.handle(
  "settings:get",
  guard(async () => {
    const current = settings ?? (await config.load(APP_ROOT));
    return {
      db: current.db ?? { host: "", port: 5432, user: "", password: "", name: "", ssl: true },
      allowRegistration: current.allowRegistration,
      allowDockerLocalDb: current.allowDockerLocalDb,
      source: current.source,
      encrypted: await config.canEncrypt(),
      configPath: config.configPath(),
      version: app.getVersion(),
    };
  })
);
ipcMain.handle("settings:test", guard((db) => testDatabase(db)));
ipcMain.handle(
  "settings:save",
  guard(async (input) => {
    const db = config.normaliseDb(input?.db);
    if (!db) return { ok: false, message: "Enter the host, database name and user name." };
    const current = settings ?? (await config.load(APP_ROOT));
    settings = { ...current, db, allowRegistration: Boolean(input.allowRegistration), allowDockerLocalDb: Boolean(input.allowDockerLocalDb), source: "user" };
    await config.save(settings);
    settingsWindow?.close();
    restart();
    return { ok: true };
  })
);
ipcMain.handle("settings:close", guard(() => settingsWindow?.close()));

/* ------------------------------------------------------------------ */
/* Menu (hidden; press Alt to show)                                    */
/* ------------------------------------------------------------------ */

const buildMenu = () =>
  Menu.buildFromTemplate([
    {
      label: "App",
      submenu: [
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: openSettings },
        { label: "Restart backend", click: restart },
        { label: "Open logs folder", click: () => void shell.openPath(LOG_DIR) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => (appOrigin ? mainWindow?.webContents.reload() : restart()) },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () =>
            void dialog.showMessageBox(mainWindow, {
              type: "info",
              title: `About ${APP_NAME}`,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail:
                `Electron ${process.versions.electron} · Node ${process.versions.node}\n` +
                `Local backend: ${appOrigin ?? "not running"}\n` +
                `Settings: ${config.configPath()}\nLogs: ${LOG_DIR}`,
            }),
        },
      ],
    },
  ]);

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = "dark";
    Menu.setApplicationMenu(buildMenu());
    fs.mkdirSync(LOG_DIR, { recursive: true });
    settings = await config.load(APP_ROOT);
    createMainWindow();
    void boot();
  });

  app.on("window-all-closed", () => app.quit());

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    Promise.allSettled([rememberBounds(), backend.stop()]).finally(() => app.quit());
  });
}
