"use strict";

const $ = (id) => document.getElementById(id);
const api = window.desktop.settings;

const setToggle = (el, on) => {
  el.setAttribute("aria-checked", String(on));
  el.querySelector(".state").textContent = on ? "On" : "Off";
};
const toggleValue = (el) => el.getAttribute("aria-checked") === "true";
for (const id of ["ssl", "registration", "docker"]) $(id).addEventListener("click", () => setToggle($(id), !toggleValue($(id))));

const showResult = (tone, text, busy = false) => {
  const box = $("result");
  box.replaceChildren();
  if (!text) return;
  const alert = document.createElement("div");
  alert.className = `alert ${tone}`;
  if (busy) {
    const spin = document.createElement("span");
    spin.className = "spinner";
    alert.append(spin);
  }
  const span = document.createElement("span");
  span.textContent = text;
  alert.append(span);
  box.append(alert);
};

const readDb = () => ({
  host: $("host").value.trim(),
  port: Number($("port").value) || 5432,
  name: $("name").value.trim(),
  user: $("user").value.trim(),
  password: $("password").value,
  ssl: toggleValue($("ssl")),
});

const validate = (db) => {
  if (!db.host) return "Enter the host.";
  if (!/^[A-Za-z0-9._:-]+$/.test(db.host)) return "The host must be a host name or IP only — no postgres://, port or path.";
  if (!Number.isInteger(db.port) || db.port < 1 || db.port > 65535) return "The port must be a number from 1 to 65535.";
  if (!db.name) return "Enter the database name.";
  if (!/^[A-Za-z0-9_$-]+$/.test(db.name)) return "The database name can only contain letters, digits, _, $ and -.";
  if (!db.user) return "Enter the user name.";
  return null;
};

const fillFromUrl = () => {
  try {
    const url = new URL($("url").value.trim());
    if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error();
    const sslMode = (url.searchParams.get("sslmode") || "").toLowerCase();
    $("host").value = url.hostname.replace(/^\[|\]$/g, "");
    $("port").value = url.port || "5432";
    $("user").value = decodeURIComponent(url.username);
    $("password").value = decodeURIComponent(url.password);
    $("name").value = decodeURIComponent(url.pathname.replace(/^\//, ""));
    setToggle($("ssl"), sslMode !== "" && sslMode !== "disable");
    $("url").value = "";
    $("url-hint").textContent = "Filled from the URL.";
    $("url-hint").className = "hint faint";
  } catch {
    $("url-hint").textContent = "Not a valid postgres:// or postgresql:// connection URL.";
    $("url-hint").className = "hint err";
  }
};
$("fill").addEventListener("click", fillFromUrl);
$("url").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    fillFromUrl();
  }
});

$("reveal").addEventListener("click", () => {
  const field = $("password");
  const show = field.type === "password";
  field.type = show ? "text" : "password";
  $("reveal").textContent = show ? "Hide" : "Show";
});

const setBusy = (busy) => {
  for (const id of ["test", "save", "cancel", "fill"]) $(id).disabled = busy;
};

$("test").addEventListener("click", async () => {
  const db = readDb();
  const problem = validate(db);
  if (problem) return showResult("error", problem);
  setBusy(true);
  showResult("info", `Connecting to ${db.host}:${db.port}…`, true);
  try {
    const result = await api.test(db);
    showResult(result.ok ? (result.warning ? "warning" : "success") : "error", result.message);
  } catch (error) {
    showResult("error", error.message);
  } finally {
    setBusy(false);
  }
});

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const db = readDb();
  const problem = validate(db);
  if (problem) return showResult("error", problem);
  setBusy(true);
  showResult("info", "Saving and starting the backend…", true);
  try {
    const result = await api.save({ db, allowRegistration: toggleValue($("registration")), allowDockerLocalDb: toggleValue($("docker")) });
    if (!result.ok) {
      showResult("error", result.message);
      setBusy(false);
    }
  } catch (error) {
    showResult("error", error.message);
    setBusy(false);
  }
});

$("cancel").addEventListener("click", () => api.close());
document.addEventListener("keydown", (event) => event.key === "Escape" && api.close());

api.get().then((current) => {
  $("host").value = current.db.host;
  $("port").value = current.db.port || 5432;
  $("name").value = current.db.name;
  $("user").value = current.db.user;
  $("password").value = current.db.password;
  setToggle($("ssl"), current.db.ssl);
  setToggle($("registration"), current.allowRegistration);
  setToggle($("docker"), current.allowDockerLocalDb);
  $("meta").textContent = `v${current.version} · ${current.encrypted ? "password stored encrypted" : "password stored in"} ${current.encrypted ? "" : current.configPath}`.trim();
  if (current.source === "defaults") showResult("info", "Pre-filled with your team's defaults. Save to keep them, or change them for this computer.");
  (current.db.host ? $("password") : $("url")).focus();
});
