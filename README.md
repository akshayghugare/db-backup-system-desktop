# DB Backup & Restore — Desktop app

The desktop app is **the same app as the website**: same login, registration, admin console, user approvals, backup & restore page and history, with the same look. The only difference is where the backend runs:

| | Website (Render) | Desktop app |
| --- | --- | --- |
| Backend runs on | Render's server | **your own computer** (inside the app) |
| Restore TO **Local database** (`localhost`) | ✗ not possible (Render can't reach your PC) | ✓ works |
| Restore TO **Deployed database** (staging / production) | ✓ works | ✓ works |
| Users, approvals, history | app database (e.g. Aiven) | **the same** app database, so both stay in sync |

## How the three folders fit together

```
db-backup-local/
├─ db-backup-system-bakcend/    ← backend (deployed to Render, unchanged)
├─ db-backup-system-frontend/   ← website (deployed to Render, unchanged)
└─ db-backup-system-desktop/    ← this folder: only the Electron wrapper
```

The desktop folder holds no copy of the app code. `npm run build:app` builds it from the other two folders:
- backend → `app/backend` (source + production dependencies, **never your `.env`**)
- frontend → `app/frontend/dist` (fresh build)

So whenever you change the website or backend, rebuild the desktop app and it picks up the change.

It's kept as a separate folder because Electron is about 200 MB. Putting it in the backend or frontend would make every Render deploy download it.

---

## For users: install & use

### Install (Windows)
1. Run **`DB-Backup-Restore-Setup-1.0.0.exe`**.
2. Windows SmartScreen may say *"Windows protected your PC"*, because the installer isn't code-signed. Click **More info → Run anyway**.
3. Choose the install folder and finish. A **DB Backup & Restore** shortcut appears on the desktop and in the Start menu.

You don't need Node.js or anything else. The app contains everything.

### First start: connect the app database
On the first start, a **Settings** window opens. This is the database that stores **user accounts, approvals and history**:

1. Use **the same database as the website** (your Aiven database), so you sign in with the same account and see the same history. Either paste the connection URL and click **Fill**, or type in Host, Port, Database name, User name, Password, and turn **Use SSL** on for Aiven.
2. Click **Test connection**. It should say *"Connected … N user account(s). Ready."*
3. Click **Save & start**.

> This isn't the database you back up. You pick Backup FROM and Restore TO inside the app for every run.

### Use
1. **Sign in** with your website account, or **Create one**. New accounts need an admin's approval, the same as on the website.
2. **Backup FROM**: your staging/source database (e.g. Aiven), with SSL **on**.
3. **Restore TO**: first choose **Restore into**:
   - **Local database**: a database on this computer, host `localhost`, SSL **off**.
   - **Deployed database**: staging, production or any other server, with SSL usually **on**. This replaces that database's data for everyone using it, so the app asks for an extra confirmation, *"This is a deployed database"*, before it runs.

   Click **Test connection** to check it.
4. Choose all tables or only some, type the destination name to confirm (and tick the deployed confirmation if needed), then click **Backup & Restore**.
5. Watch the live progress. Each step, the current table, the rows and bytes copied and the speed are shown, and the % also appears in the window title.

Admins also get **Users & access** in the sidebar to approve or reject accounts. Approvals are shared with the website.

### Menu & settings
The menu bar is hidden; press **Alt** to show it.
- **App → Settings…** (`Ctrl+,`): change the app database.
- **App → Restart backend**, **App → Open logs folder**
- **View → Reload** (`Ctrl+R`), zoom, full screen

| What | Where |
| --- | --- |
| Settings | `%APPDATA%\DB Backup & Restore\config.json` (password encrypted with Windows' DPAPI) |
| Logs | `%APPDATA%\DB Backup & Restore\logs\backend.log` |

### Troubleshooting
| Message | Fix |
| --- | --- |
| *Waiting for the database: … does not exist yet / pending migrations* | The app database hasn't been migrated. Run `npm run migrate` (and `npm run seed`) in `db-backup-system-bakcend` with those credentials. The app retries automatically, no restart needed. |
| *Wrong user name or password* / *host not found* | **App → Settings…**, fix the details, then **Test connection**. |
| Restore TO *connection refused* | Your local PostgreSQL isn't running, or the port is wrong. |
| *Restore TO cannot be "…" — that database holds this tool's user accounts* | Pick a different local database as the destination. |
| Anything else | **App → Open logs folder** and check `backend.log`. |

**Uninstall:** use *Settings → Apps → DB Backup & Restore → Uninstall*. Your settings in `%APPDATA%` are kept; delete that folder to remove them.

---

## For developers: build

Requirements: Node.js 22+, with the three folders side by side and `npm install` done in the backend and frontend.

```bash
cd db-backup-system-desktop
npm install           # once
npm start             # build app/ from the backend + frontend source, then open the app
npm run dist          # build the Windows installer → release/DB-Backup-Restore-Setup-<version>.exe
npm run dist:dir      # unpacked app only (faster) → release/win-unpacked/
```

Bump `"version"` in `package.json` before building a release you hand out.

### Publish a release (powers the website's "Download desktop app" button)
The website's **Desktop app** button, the download button in the *"restore not possible"* banner, and the link on the login page all download **directly from your website**: `https://<your-backend>/api/desktop/download`. Visitors never see or visit GitHub.

How it works: the installer (about 120 MB) is too big for git (100 MB limit) and for Render's disk (wiped on every deploy). So it's *stored* as a GitHub Release asset, and your backend streams it to the visitor with `Content-Disposition: attachment`. The backend always fetches `releases/latest/download/DB-Backup-Restore-Setup.exe`, so publishing a new release updates the website download automatically. Until a release exists, the website says *"not available yet"* instead of showing an error.

**One-time setup**
1. Create a **public** GitHub repository named `db-backup-system-desktop`. It must be public, or visitors can't download the file. Push this folder to it; `app/`, `release/` and `config/defaults.json` are already git-ignored.
2. Create a GitHub token: *Settings → Developer settings → Fine-grained token* with **Contents: Read and write** on that repository.

**Every release**
```powershell
# bump "version" in package.json first, e.g. 1.0.1
$env:GH_TOKEN = "<your token>"
npm run release
```

This builds the installer from the current backend and frontend code and uploads it to a new GitHub Release. The website button serves it straight away.

To do it by hand instead, run `npm run dist`, then on GitHub go to *Releases → Draft a new release*, attach `release/DB-Backup-Restore-Setup.exe` (keep that exact file name), and publish.

> To use a different repository, change `owner` / `repo` under `build.publish` in `package.json` **and** `INSTALLER_SOURCE_URL` in `db-backup-system-bakcend/src/controllers/desktop.controller.js`.

### Optional: a pre-configured installer for your team
To skip the first-start setup, copy `config/defaults.example.json` to `config/defaults.json`, fill in the app database (your Aiven details), and run `npm run dist`. The installer then starts ready to use.

> ⚠️ The credentials are then **inside the installer**. Anyone who has the file can read them. Only share it inside your team. `config/defaults.json` is in `.gitignore`, so never commit it.

### How it works
- `main/main.js` creates the window, shows the startup screen, and handles settings, the menu and security. The window only loads the local app; external links open in your browser.
- `main/backend.js` starts `app/backend/src/server.js` with Electron's built-in Node on `127.0.0.1:47800` (or a free port), passes it the settings as environment variables, and waits for `/api/health`.
- The backend serves the built React app, so the window shows exactly the website's UI. API calls go to the same local origin.
- `renderer/` holds the startup and settings screens, in the same purple theme.
