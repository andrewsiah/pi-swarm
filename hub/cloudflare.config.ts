import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  worker: {
    name: "pi-swarm-hub",
    entrypoint: "./src/index.ts",
    compatibilityDate: "2026-10-01",
    observability: { enabled: true },
    compatibilityFlags: ["enable_request_signal"],
    exports: {
      SwarmHub: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      SWARM: bindings.durableObject({ worker: "pi-swarm-hub", exportName: "SwarmHub" }),
      ADMIN_TOKEN: bindings.secret(),
    },
  },
});
