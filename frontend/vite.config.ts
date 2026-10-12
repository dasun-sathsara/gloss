import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8776",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (request, source) => {
            if (
              ["http://127.0.0.1:5173", "http://localhost:5173"].includes(
                source.headers.origin || "",
              )
            ) {
              request.setHeader("Origin", "http://127.0.0.1:8776");
            }
          });
        },
      },
      "/media": "http://127.0.0.1:8776",
      "/assets/fonts": "http://127.0.0.1:8776",
    },
  },
});
