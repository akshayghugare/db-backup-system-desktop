"use strict";

/**
 * Runs the existing backend (db-backup-system-bakcend/src/server.js) as a child process on 127.0.0.1,
 * using Electron's own Node runtime (ELECTRON_RUN_AS_NODE) — users do not need Node.js installed.
 * The backend also serves the built React frontend, so the window loads http://127.0.0.1:<port>/.
 */

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Uses the preferred port when free (keeps the browser storage origin — and so the sign-in — stable), else any free port. */
const pickPort = (preferred) =>
  new Promise((resolve) => {
    const tryListen = (port, fallback) => {
      const probe = net.createServer();
      probe.unref();
      probe.once("error", () => (fallback ? tryListen(0, false) : resolve(0)));
      probe.listen({ port, host: "127.0.0.1" }, () => {
        const chosen = probe.address().port;
        probe.close(() => resolve(chosen));
      });
    };
    tryListen(preferred, true);
  });

class Backend extends EventEmitter {
  constructor({ appRoot, logDir }) {
    super();
    this.appRoot = appRoot;
    this.logDir = logDir;
    this.logFile = path.join(logDir, "backend.log");
    this.child = null;
    this.port = null;
    this.stopping = false;
    this.tail = [];
  }

  get serverPath() {
    return path.join(this.appRoot, "backend", "src", "server.js");
  }

  get backendDir() {
    return path.join(this.appRoot, "backend");
  }

  openLog() {
    fs.mkdirSync(this.logDir, { recursive: true });
    try {
      if (fs.statSync(this.logFile).size > MAX_LOG_BYTES) fs.renameSync(this.logFile, `${this.logFile}.old`);
    } catch {
      /* no log yet */
    }
    return fs.createWriteStream(this.logFile, { flags: "a" });
  }

  record(stream, chunk) {
    stream.write(chunk);
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.tail.push(line);
      if (this.tail.length > 40) this.tail.shift();
    }
  }

  async start(config) {
    if (!fs.existsSync(this.serverPath)) {
      throw new Error(`The backend files are missing (${this.serverPath}). Run "npm run build:app" in db-backup-system-desktop.`);
    }
    this.stopping = false;
    this.tail = [];
    this.port = await pickPort(config.port);
    const origin = `http://127.0.0.1:${this.port}`;

    // Start from the user's environment, but drop anything that could point the backend somewhere else.
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(DB_|DATABASE_URL|RENDER|HOST$|PORT$|FRONTEND_ORIGIN|JWT_|ALLOW_|SEED_)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      ELECTRON_RUN_AS_NODE: "1",
      HOST: "127.0.0.1",
      PORT: String(this.port),
      FRONTEND_ORIGIN: origin,
      DB_HOST: config.db.host,
      DB_PORT: String(config.db.port),
      DB_USER: config.db.user,
      DB_PASSWORD: config.db.password,
      DB_NAME: config.db.name,
      DB_SSL: config.db.ssl ? "true" : "false",
      JWT_SECRET: config.jwtSecret,
      JWT_EXPIRES_IN: config.jwtExpiresIn,
      ALLOW_REGISTRATION: config.allowRegistration ? "true" : "false",
      ALLOW_DOCKER_LOCAL_DB: config.allowDockerLocalDb ? "true" : "false",
    });

    const log = this.openLog();
    log.write(`\n===== ${new Date().toISOString()} starting backend on ${origin} (database "${config.db.name}" on ${config.db.host}:${config.db.port}) =====\n`);

    const child = spawn(process.execPath, [this.serverPath], {
      cwd: this.backendDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (chunk) => this.record(log, chunk));
    child.stderr.on("data", (chunk) => this.record(log, chunk));
    child.once("exit", (code, signal) => {
      log.end(`===== backend exited (code ${code ?? "-"}, signal ${signal ?? "-"}) =====\n`);
      if (this.child === child) this.child = null;
      if (!this.stopping) this.emit("crash", { code, signal, tail: [...this.tail] });
    });
    child.once("error", (error) => {
      log.write(`Could not start the backend: ${error.message}\n`);
      if (!this.stopping) this.emit("crash", { code: null, signal: null, tail: [...this.tail, error.message] });
    });
    return origin;
  }

  /** Polls /api/health. Calls onUpdate(body) while starting; resolves true once healthy, false if stopped/crashed. */
  async waitUntilHealthy(onUpdate, isCurrent) {
    const url = `http://127.0.0.1:${this.port}/api/health`;
    while (isCurrent() && this.child) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.status === "ok") return true;
        if (body) onUpdate(body);
      } catch {
        onUpdate(null); // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    return false;
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const done = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        resolve();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(done);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(done);
        resolve();
      }
    });
  }
}

module.exports = { Backend, pickPort };
