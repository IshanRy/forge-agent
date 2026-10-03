// The whole surface the renderer gets. Everything else — the filesystem,
// child processes, the Electron API — stays on the other side of this file.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forge", {
  hostInfo: () => ipcRenderer.invoke("host:info"),

  checkPermissions: (opts) => ipcRenderer.invoke("perm:check", opts || {}),
  promptAccessibility: () => ipcRenderer.invoke("perm:prompt-accessibility"),
  openSettings: (which) => ipcRenderer.invoke("perm:open", which),
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
  quit: () => ipcRenderer.invoke("app:quit"),

  googleSignIn: () => ipcRenderer.invoke("auth:google"),

  setFrozen: (on) => ipcRenderer.invoke("freeze:set", on),

  sample: () => ipcRenderer.invoke("sample:now"),
  poster: () => ipcRenderer.invoke("screen:poster"),
  saveClips: (payload) => ipcRenderer.invoke("clips:save", payload),
  revealIncidents: () => ipcRenderer.invoke("shell:reveal"),

  // Main asks the renderer to record a deliberate quit before the window
  // goes, so the dashboard can tell a close from a crash.
  onClosing: (fn) => ipcRenderer.on("agent:closing", () => fn()),
  closeAck: () => ipcRenderer.invoke("agent:close-ack"),
});
