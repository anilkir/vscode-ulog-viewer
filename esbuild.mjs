import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
};

/** @type {import("esbuild").BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
};

/** @type {import("esbuild").BuildOptions} */
const sidebarConfig = {
  entryPoints: ["src/sidebarWebview/main.ts"],
  bundle: true,
  outfile: "dist/sidebar.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionConfig),
    esbuild.context(webviewConfig),
    esbuild.context(sidebarConfig),
  ]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("[esbuild] watching for changes...");
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig), esbuild.build(sidebarConfig)]);
  console.log("[esbuild] build complete");
}
