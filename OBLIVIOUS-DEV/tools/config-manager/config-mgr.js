#!/usr/bin/env node
// Redirect legacy entrypoint → operator CLI (stesso KeyVault).
const path = require("path");
const { spawnSync } = require("child_process");

const target = path.join(__dirname, "..", "operator", "oblivious-config.js");
const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(r.status ?? 1);
