import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: vite on :5173 proxies /api → the tsx-watch server on :8787 (spec §4).
// Build: web/dist, served single-origin by the Fastify server in `npm start`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
