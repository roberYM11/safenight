import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "leaflet/dist/leaflet.css";
import "./index.css";

if (import.meta.env.DEV && import.meta.env["VITE_DISABLE_REACT_DEVTOOLS"] !== "1") {
  void import("react-grab");
  void import("react-scan");
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<StrictMode><App /></StrictMode>);
}

