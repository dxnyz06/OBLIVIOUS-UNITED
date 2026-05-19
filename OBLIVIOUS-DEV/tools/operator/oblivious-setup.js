#!/usr/bin/env node
/**
 * OBLIVIOUS — Operator setup wizard (DEV / VPS / custom path).
 * Wraps oblivious-config.js (same KeyVault format as the Hub).
 *
 * Run: node oblivious-setup.js
 *      or double-click Run-Oblivious-Setup.bat
 */

const path = require("path");
const readline = require("readline");
const { spawnSync } = require("child_process");

function repoRootFromOperator() {
  return path.resolve(__dirname, "..", "..", "..");
}

function defaultPaths() {
  const root = repoRootFromOperator();
  return {
    dev: path.join(root, "OBLIVIOUS-DEV", "secure-config", "dev-local", "config.enc"),
    vps: path.join(root, "OBLIVIOUS-VPS", "config", "config.enc"),
  };
}

function runConfig(extraArgs) {
  const cli = path.join(__dirname, "oblivious-config.js");
  const r = spawnSync(process.execPath, [cli, ...extraArgs], {
    stdio: "inherit",
    cwd: __dirname,
    env: process.env,
    shell: false,
  });
  const code = typeof r.status === "number" ? r.status : 1;
  return code;
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error("[oblivious-setup] Richiede una console interattiva (TTY).");
    process.exit(2);
  }

  const defs = defaultPaths();
  let targetFile = defs.dev;
  let targetLabel = "DEV (OBLIVIOUS-DEV/secure-config/dev-local/config.enc)";

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  OBLIVIOUS — Config wizard (password + API key → config.enc)      ║
║  Stesso formato dell’Hub (KeyVault AES-256-GCM).                  ║
╚══════════════════════════════════════════════════════════════════╝
`);

  const menuTarget = `
--- Target vault ---
  Percorso attuale: ${targetFile}
  Etichetta: ${targetLabel}

  [T] Cambia target (DEV / VPS / path personalizzato)
  [I] Init nuovo vault (solo password, vault vuoto)
  [K] Imposta / cambia chiave provider (OpenAI, Anthropic, …)
  [R] Rimuovi chiave provider
  [L] Lista provider (impostato / vuoto)
  [G] Mostra prefisso mascherato di una chiave
  [S] Stato / test decrypt
  [P] Cambia password vault (ri-cifra tutto)
  [E] Reseal (stessa password, nuovi salt/IV)
  [Q] Esci

Scelta: `;

  for (;;) {
    const choice = (await ask(menuTarget)).trim().toUpperCase();
    if (choice === "Q") break;

    if (choice === "T") {
      const sub = (await ask("[D]EV  [V]PS  [C]ustom path: "))
        .trim()
        .toUpperCase();
      if (sub === "D") {
        targetFile = defs.dev;
        targetLabel = "DEV";
      } else if (sub === "V") {
        targetFile = defs.vps;
        targetLabel = "VPS bundle";
      } else if (sub === "C") {
        const p = (await ask("Percorso completo di config.enc: ")).trim();
        if (!p) {
          console.log("(annullato)");
          continue;
        }
        targetFile = path.resolve(p);
        targetLabel = "custom";
      } else {
        console.log("Scelta non valida.");
      }
      console.log(`→ Ora lavori su: ${targetFile}\n`);
      continue;
    }

    const rel = path.relative(process.cwd(), targetFile);
    const fileArg = rel && !rel.startsWith("..") && rel !== targetFile ? rel : targetFile;

    const common = ["--file", fileArg];

    if (choice === "I") {
      runConfig(["init", ...common]);
      continue;
    }
    if (choice === "K") {
      const raw = (await ask(`Provider (${[
        "openai",
        "anthropic",
        "google",
        "xai",
        "deepseek",
        "qwen",
        "perplexity",
      ].join(", ")}): `)).trim().toLowerCase();
      const key = await ask("API key (incolla qui): ");
      runConfig(["set", "--provider", raw, "--key", key == null ? "" : key, ...common]);
      continue;
    }
    if (choice === "R") {
      const raw = (await ask("Provider da rimuovere: ")).trim().toLowerCase();
      runConfig(["remove", "--provider", raw, ...common]);
      continue;
    }
    if (choice === "L") {
      runConfig(["list", ...common]);
      continue;
    }
    if (choice === "G") {
      const raw = (await ask("Provider: ")).trim().toLowerCase();
      runConfig(["get", "--provider", raw, ...common]);
      continue;
    }
    if (choice === "S") {
      runConfig(["test-decrypt", ...common]);
      continue;
    }
    if (choice === "P") {
      runConfig(["change-password", ...common]);
      continue;
    }
    if (choice === "E") {
      runConfig(["reseal", ...common]);
      continue;
    }
    console.log("Scelta non valida.");
  }

  rl.close();
  console.log("Fine.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
