#!/usr/bin/env node
// Cross-compiles lily-envd into dist/envd/<goos>-<goarch>/lily-envd.
//
// usage: node scripts/build-envd.mjs [--host-only]
//
// Binaries are static (CGO_ENABLED=0) and stripped. --host-only builds just the current platform.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = [
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "darwin", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" },
];

const GOOS_BY_PLATFORM = { linux: "linux", darwin: "darwin" };
const GOARCH_BY_ARCH = { x64: "amd64", arm64: "arm64" };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = join(repoRoot, "envd");
const outRoot = join(repoRoot, "dist", "envd");

function fail(message) {
  console.error(`build-envd: ${message}`);
  process.exit(1);
}

function hostTarget() {
  const goos = GOOS_BY_PLATFORM[process.platform];
  const goarch = GOARCH_BY_ARCH[process.arch];
  if (!goos || !goarch) fail(`unsupported host platform ${process.platform}/${process.arch}`);
  return { goos, goarch };
}

function parseArgs(argv) {
  let hostOnly = false;
  for (const arg of argv) {
    if (arg === "--host-only") hostOnly = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("usage: node scripts/build-envd.mjs [--host-only]");
      process.exit(0);
    } else fail(`unknown argument ${arg}`);
  }
  return { hostOnly };
}

function build({ goos, goarch }) {
  const out = join(outRoot, `${goos}-${goarch}`, "lily-envd");
  mkdirSync(dirname(out), { recursive: true });
  const result = spawnSync(
    "go",
    ["build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w", "-o", out, "."],
    {
      cwd: moduleDir,
      env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
      stdio: "inherit",
    },
  );
  if (result.error) fail(`cannot run go: ${result.error.message}`);
  if (result.status !== 0) fail(`go build failed for ${goos}/${goarch}`);
  return out;
}

const { hostOnly } = parseArgs(process.argv.slice(2));
const targets = hostOnly ? [hostTarget()] : TARGETS;
for (const target of targets) {
  console.log(build(target));
}
