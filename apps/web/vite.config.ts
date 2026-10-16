import {
  defineConfig,
  type Plugin,
  type PreviewServer,
  type ViteDevServer,
} from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, networkSettings, assetId } from "@satora/striker-protocol";
import type { AppConfig } from "./src/config.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
process.env.EMULATOR_CONFIG_DIR = path.resolve(
  root,
  process.env.EMULATOR_CONFIG_DIR ?? ".emulator",
);
const settings = networkSettings(),
  taker = loadConfig(
    "taker",
    path.resolve(root, process.env.TAKER_CONFIG_DIR ?? ".taker"),
  );
const configured = process.env.WEB_ASSET_ID ?? taker.config.assetId;
const symbol = process.env.WEB_ASSET_SYMBOL ?? "POC";
const decimals = Number(process.env.WEB_ASSET_DECIMALS ?? "0");
if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
  throw new Error("Invalid WEB_ASSET_DECIMALS");
const config: AppConfig = {
  ...settings,
  asset: {
    id: typeof configured === "string" ? assetId(configured) : null,
    symbol,
    name: process.env.WEB_ASSET_NAME ?? "Striker test asset",
    decimals,
    demo: symbol === "POC",
  },
};
const json = JSON.stringify(config);
const publicConfig = (): Plugin => {
  const mount = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      if (
        req.url?.startsWith("/api/emulator") &&
        (req.method !== "GET" ||
          req.url.split("?")[0] !== "/api/emulator/v1/info")
      ) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      if (req.url?.split("?")[0] !== "/config.json") return next();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(json);
    });
  };
  return {
    name: "striker-public-config",
    configureServer: mount,
    configurePreviewServer: mount,
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "config.json", source: json });
    },
  };
};
const proxy = {
  "/api/striker": {
    target: String(taker.config.striker),
    changeOrigin: true,
    rewrite: (url: string) => url.replace(/^\/api\/striker/, ""),
  },
  "/api/ark": {
    target: settings.arkUrl,
    changeOrigin: true,
    rewrite: (url: string) => url.replace(/^\/api\/ark/, ""),
  },
  "/api/emulator": {
    target: settings.emulatorUrl,
    changeOrigin: true,
    rewrite: (url: string) => url.replace(/^\/api\/emulator/, ""),
  },
  "/api/esplora": {
    target: settings.esploraUrl,
    changeOrigin: true,
    rewrite: (url: string) => url.replace(/^\/api\/esplora/, ""),
  },
};
const https =
  process.env.WEB_TLS_CERT && process.env.WEB_TLS_KEY
    ? {
        cert: readFileSync(process.env.WEB_TLS_CERT),
        key: readFileSync(process.env.WEB_TLS_KEY),
      }
    : undefined;
const host = process.env.WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.WEB_PORT ?? "5173");
const allowedHosts = process.env.WEB_ALLOWED_HOSTS?.split(",") ?? [];
export default defineConfig({
  root: path.join(root, "apps/web"),
  plugins: [react(), publicConfig()],
  server: {
    host,
    https,
    allowedHosts,
    port,
    strictPort: true,
    proxy,
    fs: {
      strict: true,
      allow: [
        path.join(root, "apps/web"),
        path.join(root, "packages"),
        path.join(root, "node_modules"),
      ],
      deny: [
        "**/.git/**",
        "**/.env*",
        "**/private-key",
        "**/.maker/**",
        "**/.taker/**",
        "**/.striker/**",
        "**/.emulator/**",
        "**/.cache/**",
        "**/*.pem",
        "**/*.key",
      ],
    },
  },
  preview: { host, https, allowedHosts, port, strictPort: true, proxy },
});
