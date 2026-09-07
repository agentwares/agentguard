import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/example-http.ts"],
  format: ["esm"],
  platform: "node",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
});
