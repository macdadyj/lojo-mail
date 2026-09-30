import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installKeyWatch } from "./unlock.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing root");
// Backstop for hosts that drop the frame-ancestors header: never render inside a frame.
if (window.top !== window.self) throw new Error("refusing to run inside a frame");
installKeyWatch();
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The shell still works if the worker cannot install.
    });
  });
}
