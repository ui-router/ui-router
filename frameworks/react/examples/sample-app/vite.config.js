import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    host: "0.0.0.0",
    port: 3000,
  },
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
  publicDir: "static",
});
