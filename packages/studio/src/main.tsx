import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Studio root element #root not found in document");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
