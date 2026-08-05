import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      /*
       * Aliased to the package's source rather than left to resolve through the
       * workspace symlink in `node_modules`, which Vite would treat as a dependency and
       * skip transpiling — and `shared` ships `.ts`, not built JavaScript. Pointing at
       * the source directory compiles it as first-party code, which is what it is.
       */
      "@yaniv/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    proxy: {
      /*
       * The client is same-origin in development because it is same-origin in
       * production — one service serves both (docs/adr/0003). Proxying the socket here
       * rather than pointing the client at `localhost:3000` means neither side ever
       * needs CORS, and there is no build-time server URL to get wrong.
       */
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true,
      },
    },
  },
});
