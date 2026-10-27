import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    proxy: {
      "/api": {
        target: "http://localhost:3053",
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          const setApiOrigin = (request: { setHeader(name: string, value: string): void }) => {
            request.setHeader("Origin", "http://localhost:3053");
          };
          proxy.on("proxyReq", setApiOrigin);
          proxy.on("proxyReqWs", setApiOrigin);
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
