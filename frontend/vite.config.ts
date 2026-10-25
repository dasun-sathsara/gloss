import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    // Playwright owns e2e/; Vitest must not collect its specs.
    exclude: [...configDefaults.exclude, "e2e/**"],
    // No Vitest unit tests yet; `vp test` passes, and future tests run automatically.
    passWithNoTests: true,
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
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
