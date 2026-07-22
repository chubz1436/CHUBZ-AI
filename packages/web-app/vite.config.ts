import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022", sourcemap: false },
  server: { host: "127.0.0.1", port: 4318, proxy: { "/v1": "http://127.0.0.1:4317", "/healthz": "http://127.0.0.1:4317", "/readyz": "http://127.0.0.1:4317" } },
  test: { environment: "node" },
});
