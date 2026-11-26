"use strict";

// Exposed only to the app's own local pages (startup screen, settings). The web app loaded from the
// local backend (http://127.0.0.1) gets nothing — it behaves exactly like the website.
const { contextBridge, ipcRenderer } = require("electron");

if (window.location.protocol === "file:") {
  contextBridge.exposeInMainWorld("desktop", {
    getState: () => ipcRenderer.invoke("desktop:getState"),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("desktop:state", listener);
      return () => ipcRenderer.removeListener("desktop:state", listener);
    },
    retry: () => ipcRenderer.invoke("desktop:retry"),
    openSettings: () => ipcRenderer.invoke("desktop:openSettings"),
    openLogs: () => ipcRenderer.invoke("desktop:openLogs"),
    settings: {
      get: () => ipcRenderer.invoke("settings:get"),
      test: (db) => ipcRenderer.invoke("settings:test", db),
      save: (input) => ipcRenderer.invoke("settings:save", input),
      close: () => ipcRenderer.invoke("settings:close"),
    },
  });
}
