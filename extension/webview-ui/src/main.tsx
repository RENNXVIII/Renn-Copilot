import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Sidebar } from "./Sidebar";
import "./styles.css";

declare global {
  interface Window {
    __RENN_VIEW_MODE__?: "panel" | "sidebar";
  }
}

const Root = window.__RENN_VIEW_MODE__ === "sidebar" ? Sidebar : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
