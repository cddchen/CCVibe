import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:4733", ws: true },
      "/health": "http://127.0.0.1:4733",
    },
  },
});