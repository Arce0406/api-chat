import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import "./ui/styles.css";

// 檔案拖到輸入框以外的地方時，不要讓視窗直接開啟那個檔案
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => event.preventDefault());
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
