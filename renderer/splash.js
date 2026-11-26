"use strict";

const $ = (id) => document.getElementById(id);

const button = (label, onClick, primary = false) => {
  const el = document.createElement("button");
  el.type = "button";
  el.className = primary ? "btn btn-primary" : "btn";
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
};

const render = (state) => {
  const busy = state.phase === "starting" || state.phase === "waiting" || state.phase === "ready";
  $("title").textContent = state.title || "";
  $("message").textContent = state.message || "";
  $("dots").hidden = !busy;

  const loader = $("loader");
  loader.classList.toggle("idle", state.phase === "setup");
  loader.classList.toggle("error", state.phase === "error");

  for (const li of $("steps").children) {
    const index = Number(li.dataset.step);
    li.className = "";
    if (index < state.step || state.phase === "ready") li.classList.add("done");
    else if (index === state.step) li.classList.add(state.phase === "error" ? "failed" : "current");
  }

  const detail = $("detail");
  detail.hidden = !state.detail;
  detail.textContent = state.detail || "";
  detail.classList.toggle("warn", state.phase === "waiting");

  const actions = $("actions");
  actions.replaceChildren();
  if (state.phase === "setup") {
    actions.append(button("Set up database", () => window.desktop.openSettings(), true));
  } else if (state.phase === "error") {
    actions.append(
      button("Try again", () => window.desktop.retry(), true),
      button("Settings", () => window.desktop.openSettings()),
      button("Open logs", () => window.desktop.openLogs())
    );
  } else if (state.phase === "waiting") {
    actions.append(button("Settings", () => window.desktop.openSettings()), button("Open logs", () => window.desktop.openLogs()));
  }
  document.title = state.phase === "ready" ? "DB Backup & Restore" : `${state.title} — DB Backup & Restore`;
};

window.desktop.onState(render);
window.desktop.getState().then(render);
