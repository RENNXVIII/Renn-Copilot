import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds to extension/media/webview/ so the extension host can load the
// bundle via webview.asWebviewUri() -- see ../src/webview-html.ts.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../media/webview",
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      output: {
        entryFileNames: "bundle.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (info) => (info.name?.endsWith(".css") ? "bundle.css" : "assets/[name][extname]"),
      },
    },
  },
});
