#!/usr/bin/env node
// Keep the app version in sync across package.json, src-tauri/Cargo.toml and
// src-tauri/tauri.conf.json.
//
//   node scripts/version.mjs              print the current versions
//   node scripts/version.mjs set 0.2.0    set all three to 0.2.0
//   node scripts/version.mjs check v0.2.0 fail unless all three equal the tag
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "package.json": {
    get: (t) => JSON.parse(t).version,
    set: (t, v) => t.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
  "src-tauri/Cargo.toml": {
    get: (t) => t.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1],
    set: (t, v) => t.replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${v}$2`),
  },
  "src-tauri/tauri.conf.json": {
    get: (t) => JSON.parse(t).version,
    set: (t, v) => t.replace(/("version":\s*")[^"]+(")/, `$1${v}$2`),
  },
};

const read = (f) => readFileSync(join(root, f), "utf8");
const versions = () => Object.fromEntries(Object.entries(files).map(([f, h]) => [f, h.get(read(f))]));
const [cmd, arg] = process.argv.slice(2);

if (!cmd) {
  console.table(versions());
} else if (cmd === "set") {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(arg ?? "")) {
    console.error("usage: node scripts/version.mjs set <major.minor.patch>");
    process.exit(2);
  }
  for (const [f, h] of Object.entries(files)) writeFileSync(join(root, f), h.set(read(f), arg));
  console.table(versions());
  console.log(`Next: commit, then  git tag v${arg} && git push origin v${arg}`);
} else if (cmd === "check") {
  const want = (arg ?? "").replace(/^v/, "");
  const bad = Object.entries(versions()).filter(([, v]) => v !== want);
  if (bad.length) {
    for (const [f, v] of bad) console.error(`${f}: version ${v}, but the tag is ${arg}`);
    console.error("Run `node scripts/version.mjs set <version>` and tag again.");
    process.exit(1);
  }
  console.log(`All versions are ${want}`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
