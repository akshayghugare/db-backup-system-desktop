"use strict";

/**
 * Assembles db-backup-system-desktop/app/ from the EXISTING projects — nothing is duplicated by hand,
 * so the desktop app always has the same code as the website:
 *
 *   app/backend/         ← ../db-backup-system-bakcend   (src, migrations, seeds, scripts + production node_modules; never .env)
 *   app/frontend/dist/   ← ../db-backup-system-frontend  (fresh `vite build`, API calls go to the same origin)
 *   app/defaults.json    ← config/defaults.json          (optional team defaults for the app database)
 *
 * The backend serves app/frontend/dist itself (src/server.js → ../../frontend/dist).
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BACKEND_SRC = path.resolve(ROOT, "..", "db-backup-system-bakcend");
const FRONTEND_SRC = path.resolve(ROOT, "..", "db-backup-system-frontend");
const OUT = path.join(ROOT, "app");
const BACKEND_OUT = path.join(OUT, "backend");
const FRONTEND_OUT = path.join(OUT, "frontend", "dist");

const step = (text) => console.log(`\n▸ ${text}`);
const fail = (text) => {
  console.error(`\n✗ ${text}`);
  process.exit(1);
};

for (const [label, dir] of [
  ["Backend", BACKEND_SRC],
  ["Frontend", FRONTEND_SRC],
]) {
  if (!fs.existsSync(path.join(dir, "package.json"))) fail(`${label} project not found at ${dir}. Keep the three folders side by side.`);
}

step("Cleaning app/");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(BACKEND_OUT, { recursive: true });

step(`Copying backend from ${BACKEND_SRC}`);
for (const item of ["package.json", "package-lock.json", "src", "migrations", "seeds", "scripts"]) {
  const from = path.join(BACKEND_SRC, item);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(BACKEND_OUT, item), { recursive: true });
}

step("Installing backend production dependencies");
execSync("npm ci --omit=dev --no-audit --no-fund", { cwd: BACKEND_OUT, stdio: "inherit" });

step(`Building frontend from ${FRONTEND_SRC}`);
if (!fs.existsSync(path.join(FRONTEND_SRC, "node_modules", "vite"))) {
  execSync("npm ci --no-audit --no-fund", { cwd: FRONTEND_SRC, stdio: "inherit" });
}
execSync(`"${process.execPath}" "${path.join(FRONTEND_SRC, "node_modules", "vite", "bin", "vite.js")}" build --outDir "${FRONTEND_OUT}" --emptyOutDir`, {
  cwd: FRONTEND_SRC,
  stdio: "inherit",
  // "/" overrides the frontend's .env value and becomes "" after trimming → API calls use the same origin
  // (the local backend that serves the page). The website's own build is not affected.
  env: { ...process.env, VITE_API_BASE_URL: "/" },
});
if (!fs.existsSync(path.join(FRONTEND_OUT, "index.html"))) fail("The frontend build did not produce index.html.");

const defaults = path.join(ROOT, "config", "defaults.json");
if (fs.existsSync(defaults)) {
  step("Including team defaults from config/defaults.json");
  JSON.parse(fs.readFileSync(defaults, "utf8")); // fail early on invalid JSON
  fs.copyFileSync(defaults, path.join(OUT, "defaults.json"));
}

const version = JSON.parse(fs.readFileSync(path.join(BACKEND_SRC, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(OUT, "build-info.json"), JSON.stringify({ built_at: new Date().toISOString(), backend_version: version }, null, 2));

console.log("\n✓ app/ is ready (backend + frontend from the current source).");
