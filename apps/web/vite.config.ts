import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.RULEDECK_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": { target: process.env.RULEDECK_API_URL ?? "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
