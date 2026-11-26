"use strict";

/**
 * Desktop settings, stored in the user's app-data folder (never in the install folder):
 *   %APPDATA%\DB Backup & Restore\config.json
 *
 * Secrets (database password, JWT secret) are encrypted with the operating system's key store
 * (Windows DPAPI / macOS Keychain) through Electron's safeStorage, when available.
 *
 * If no settings exist yet, optional team defaults bundled at build time (config/defaults.json →
 * resources/app/defaults.json) are used, so a pre-configured installer works without any setup.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

const DEFAULT_PORT = 47800;

const configPath = () => path.join(app.getPath("userData"), "config.json");

const canEncrypt = async () => {
  try {
    return await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
};

const seal = async (text) => {
  if (!text) return { plain: "" };
  if (!(await canEncrypt())) return { plain: text };
  return { enc: (await safeStorage.encryptStringAsync(text)).toString("base64") };
};

const unseal = async (box) => {
  if (!box) return "";
  if (typeof box === "string") return box;
  if (box.enc) {
    try {
      return (await safeStorage.decryptStringAsync(Buffer.from(box.enc, "base64"))).result;
    } catch {
      return ""; // encrypted on another computer / user account — ask again
    }
  }
  return box.plain || "";
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const normaliseDb = (db) =>
  db && db.host && db.name && db.user
    ? {
        host: String(db.host).trim(),
        port: Number(db.port) || 5432,
        user: String(db.user).trim(),
        password: String(db.password ?? ""),
        name: String(db.name).trim(),
        ssl: Boolean(db.ssl),
      }
    : null;

/** Returns the effective settings (user settings, else bundled team defaults). */
const load = async (appRoot) => {
  const saved = readJson(configPath());
  const defaults = readJson(path.join(appRoot, "defaults.json"));

  const config = {
    db: null,
    allowRegistration: true,
    allowDockerLocalDb: false,
    jwtExpiresIn: "8h",
    jwtSecret: "",
    port: DEFAULT_PORT,
    window: null,
    source: "none",
  };

  if (defaults) {
    config.db = normaliseDb(defaults.db);
    if (typeof defaults.allowRegistration === "boolean") config.allowRegistration = defaults.allowRegistration;
    if (typeof defaults.allowDockerLocalDb === "boolean") config.allowDockerLocalDb = defaults.allowDockerLocalDb;
    if (defaults.jwtExpiresIn) config.jwtExpiresIn = String(defaults.jwtExpiresIn);
    if (config.db) config.source = "defaults";
  }

  if (saved) {
    const db = saved.db ? normaliseDb({ ...saved.db, password: await unseal(saved.db.password) }) : null;
    if (db) {
      config.db = db;
      config.source = "user";
    }
    if (typeof saved.allowRegistration === "boolean") config.allowRegistration = saved.allowRegistration;
    if (typeof saved.allowDockerLocalDb === "boolean") config.allowDockerLocalDb = saved.allowDockerLocalDb;
    if (saved.jwtExpiresIn) config.jwtExpiresIn = String(saved.jwtExpiresIn);
    config.jwtSecret = await unseal(saved.jwtSecret);
    if (Number.isInteger(saved.port)) config.port = saved.port;
    config.window = saved.window ?? null;
  }

  // One random sign-in secret per installation, created on first start and kept, so users stay signed in across restarts.
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    config.jwtSecret = crypto.randomBytes(48).toString("base64url");
    await save(config);
  }
  return config;
};

const save = async (config) => {
  const data = {
    db: config.db ? { ...config.db, password: await seal(config.db.password) } : null,
    allowRegistration: config.allowRegistration,
    allowDockerLocalDb: config.allowDockerLocalDb,
    jwtExpiresIn: config.jwtExpiresIn,
    jwtSecret: await seal(config.jwtSecret),
    port: config.port,
    window: config.window ?? null,
  };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const temp = `${configPath()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, configPath());
};

module.exports = { DEFAULT_PORT, canEncrypt, configPath, load, normaliseDb, save };
