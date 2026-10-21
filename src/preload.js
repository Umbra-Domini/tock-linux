const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tock", {
  settings: ipcRenderer.sendSync("get-settings"),        // { clock, screensaver } as last saved
  save: patch => ipcRenderer.invoke("save-settings", patch),
  preview: draft => ipcRenderer.send("preview-screensaver", draft),
  quit: () => ipcRenderer.send("quit")                   // screensaver / preview: leave on input
});