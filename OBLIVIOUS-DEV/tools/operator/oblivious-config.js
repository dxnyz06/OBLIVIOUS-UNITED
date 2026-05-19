#!/usr/bin/env node
/**
 * OBLIVIOUS — Config Manager (operator CLI).
 * Usa il KeyVault runtime dell'hub (nessun formato parallelo).
 *
 * Comandi:
 *   init              Crea config.enc vuoto (solo password)
 *   set               Imposta chiave provider (--provider --key)
 *   remove            Rimuove un provider
 *   list              Elenco provider (set / vuoto)
 *   get               Mostra prefisso mascherato di una chiave
 *   status            File esiste, decrypt OK, conteggio
 *   test-decrypt      Come status + exit 1 se fallisce
 *   change-password   Ri-cifra con nuova password
 *   reseal            Stessa password, nuovo salt/iv
 *   wizard            Menu interattivo (TTY)
 *
 * Opzioni comuni: --file <path>  [--password ...]  | KEYVAULT_PASSPHRASE
 *
 * La passphrase CLI/env serve agli script non interattivi; l'hub Electron con
 * config.enc presente mostra sempre il modal di unlock (SecureBoot).
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { requireService } = require("./lib/resolve-services");

const KeyVault = requireService("KeyVault.js");

const PROVIDERS = ["openai", "anthropic", "google", "xai", "deepseek", "qwen", "perplexity"];

const ALIASES = {
  claude: "anthropic",
  anthropic: "anthropic",
  openai: "openai",
  gemini: "google",
  google: "google",
  grok: "xai",
  xai: "xai",
  deepseek: "deepseek",
  qwen: "qwen",
  perplexity: "perplexity",
};

function fail(msg) {
  console.error("[oblivious-config] " + msg);
  process.exit(2);
}

function argv() {
  const out = { _: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x.startsWith("--")) {
      const k = x.slice(2);
      const v = a[i + 1];
      if (!v || v.startsWith("--")) out[k] = true;
      else {
        out[k] = v;
        i++;
      }
    } else out._.push(x);
  }
  return out;
}

async function readPassword(label, argvObj, envName, rl) {
  if (argvObj.password) return argvObj.password;
  if (process.env[envName]) return process.env[envName];
  if (!process.stdin.isTTY) fail(`password richiesta per ${label}: usa --password o ${envName}`);
  return new Promise((resolve) => {
    rl.question(`${label} (input visibile — evita schermate condivise): `, (ans) =>
      resolve((ans || "").trim())
    );
  });
}

async function openVault(file, passphrase, failIfMissing) {
  const exists = fs.existsSync(file);
  if (!exists && failIfMissing) fail(`file non trovato: ${file}`);
  const kv = new KeyVault({
    file: exists ? file : null,
    passphrase,
    envFallback: {},
    telemetry: null,
  });
  await kv.load();
  if (exists && passphrase && kv.source() !== "vault") {
    fail("decrypt fallito (password errata o file corrotto)");
  }
  return kv;
}

async function dumpKeys(kv) {
  const obj = {};
  for (const p of PROVIDERS) if (kv.has(p)) obj[p] = kv.get(p);
  return obj;
}

async function cmdInit(args) {
  const file = args.file || "config.enc";
  if (fs.existsSync(file)) fail(`esiste già: ${file} (rimuovi o usa change-password)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pw = await readPassword("Nuova password vault", args, "KEYVAULT_PASSPHRASE", rl);
    if (!pw) fail("password vuota rifiutata");
    const kv = new KeyVault({ file, passphrase: pw, envFallback: {}, telemetry: null });
    await kv.save({});
    console.log(`[oblivious-config] creato ${path.resolve(file)} (vault vuoto)`);
  } finally {
    rl.close();
  }
}

async function cmdSet(args) {
  const file = args.file || "config.enc";
  const raw = (args.provider || "").toLowerCase();
  const provider = ALIASES[raw] || raw;
  const key = args.key;
  if (!PROVIDERS.includes(provider)) fail(`provider sconosciuto: ${raw}`);
  if (key === undefined) fail("usa --key \"...\" (stringa vuota per rimuovere)");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pw = await readPassword("Password vault", args, "KEYVAULT_PASSPHRASE", rl);
    const kv = await openVault(file, pw, true);
    const cur = await dumpKeys(kv);
    if (key === "") delete cur[provider];
    else cur[provider] = key;
    kv.passphrase = pw;
    kv.file = file;
    await kv.save(cur);
    console.log(`[oblivious-config] salvato ${path.resolve(file)} (${Object.keys(cur).length} chiavi)`);
  } finally {
    rl.close();
  }
}

async function cmdRemove(args) {
  args.key = "";
  await cmdSet(args);
}

async function cmdList(args) {
  const file = args.file || "config.enc";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pw = await readPassword("Password vault", args, "KEYVAULT_PASSPHRASE", rl);
    const kv = await openVault(file, pw, true);
    for (const p of PROVIDERS) console.log(`  ${p.padEnd(12)} ${kv.has(p) ? "impostato" : "(vuoto)"}`);
  } finally {
    rl.close();
  }
}

async function cmdGet(args) {
  const file = args.file || "config.enc";
  const raw = (args.provider || "").toLowerCase();
  const provider = ALIASES[raw] || raw;
  if (!PROVIDERS.includes(provider)) fail(`provider sconosciuto: ${raw}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pw = await readPassword("Password vault", args, "KEYVAULT_PASSPHRASE", rl);
    const kv = await openVault(file, pw, true);
    if (!kv.has(provider)) {
      console.log("(non impostato)");
      return;
    }
    const v = kv.get(provider);
    const masked = v.length > 12 ? v.slice(0, 6) + "…" + v.slice(-4) : "***";
    console.log(`${provider} = ${masked} (len=${v.length})`);
  } finally {
    rl.close();
  }
}

async function cmdStatus(args, exitOnFail) {
  const file = args.file || "config.enc";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pw = await readPassword("Password vault", args, "KEYVAULT_PASSPHRASE", rl);
    if (!fs.existsSync(file)) {
      console.log(`status: MISSING file=${path.resolve(file)}`);
      if (exitOnFail) process.exit(1);
      return;
    }
    try {
      const kv = await openVault(file, pw, true);
      const cur = await dumpKeys(kv);
      const n = Object.keys(cur).length;
      console.log(`status: OK file=${path.resolve(file)} keys=${n} source=${kv.source()}`);
    } catch (e) {
      console.log(`status: DECRYPT_FAIL (${e.message})`);
      if (exitOnFail) process.exit(1);
    }
  } finally {
    rl.close();
  }
}

async function cmdChangePassword(args) {
  const file = args.file || "config.enc";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const oldPw =
      args["password-old"] ||
      (await readPassword("Password attuale", {}, "", rl));
    const newPw =
      args["password-new"] ||
      (await readPassword("Nuova password", {}, "", rl));
    if (!newPw) fail("nuova password vuota");
    const kv = await openVault(file, oldPw, true);
    const cur = await dumpKeys(kv);
    const kv2 = new KeyVault({ file, passphrase: newPw, envFallback: {}, telemetry: null });
    await kv2.save(cur);
    console.log(`[oblivious-config] password cambiata e vault ri-cifrato (${Object.keys(cur).length} chiavi)`);
  } finally {
    rl.close();
  }
}

async function cmdReseal(args) {
  const file = args.file || "config.enc";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pw = await readPassword("Password vault", args, "KEYVAULT_PASSPHRASE", rl);
    const kv = await openVault(file, pw, true);
    const cur = await dumpKeys(kv);
    await kv.save(cur);
    console.log(`[oblivious-config] reseal OK ${path.resolve(file)}`);
  } finally {
    rl.close();
  }
}

async function cmdWizard() {
  if (!process.stdin.isTTY) fail("wizard richiede TTY");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  console.log("\n=== OBLIVIOUS Config Manager (wizard) ===\n");
  const file = (await ask("Percorso config.enc [config.enc]: ")).trim() || "config.enc";
  const menu = `
1) init nuovo vault
2) imposta chiave provider
3) lista provider
4) stato / test decrypt
5) cambia password vault
6) esci
Scelta: `;
  for (;;) {
    const c = (await ask(menu)).trim();
    if (c === "6") break;
    const fakeArgv = { file };
    try {
      if (c === "1") {
        await cmdInit({ file });
        continue;
      }
      fakeArgv.password = (await ask("Password vault: ")).trim();
      if (!fakeArgv.password && !process.env.KEYVAULT_PASSPHRASE) {
        console.error("[wizard] password richiesta");
        continue;
      }
      if (c === "2") {
        const pr = (await ask(`Provider (${PROVIDERS.join(", ")}): `)).trim().toLowerCase();
        const mapped = ALIASES[pr] || pr;
        const key = (await ask("API key (vuoto = rimuovi): ")).trim();
        await cmdSet({ file, provider: mapped, key, password: fakeArgv.password });
      }
      if (c === "3") await cmdList({ file, password: fakeArgv.password });
      if (c === "4") await cmdStatus({ file, password: fakeArgv.password }, false);
      if (c === "5") {
        const np = (await ask("Nuova password vault: ")).trim();
        if (!np) {
          console.error("[wizard] nuova password vuota");
          continue;
        }
        await cmdChangePassword({
          file,
          "password-old": fakeArgv.password,
          "password-new": np,
        });
      }
    } catch (e) {
      console.error("[wizard] " + e.message);
    }
  }
  rl.close();
}

function usage() {
  console.log(`
OBLIVIOUS Config Manager (usa KeyVault dell'hub)

Comandi:
  init [--file config.enc] [--password ...]
  set --provider <nome> --key "<valore>" [--file ...]
  set-provider-key   (alias di set)
  remove --provider <nome> [--file ...]
  remove-provider-key   (alias di remove)
  list [--file ...]
  get --provider <nome> [--file ...]
  status [--file ...]
  test-decrypt [--file ...]
  change-password [--file ...] [--password-old x --password-new y]
  reseal [--file ...]
  wizard

Alias provider: claude→anthropic, gemini→google, grok→xai

Password: --password o KEYVAULT_PASSPHRASE (mai loggata).
`);
}

(async () => {
  const a = argv();
  const cmd = a._[0];
  switch (cmd) {
    case "init":
      await cmdInit(a);
      break;
    case "set":
    case "set-provider-key":
      await cmdSet(a);
      break;
    case "remove":
    case "remove-provider-key":
      await cmdRemove(a);
      break;
    case "list":
      await cmdList(a);
      break;
    case "list-providers":
      await cmdList(a);
      break;
    case "get":
      await cmdGet(a);
      break;
    case "status":
    case "show-status":
      await cmdStatus(a, false);
      break;
    case "test-decrypt":
      await cmdStatus(a, true);
      break;
    case "change-password":
      await cmdChangePassword(a);
      break;
    case "reseal":
      await cmdReseal(a);
      break;
    case "wizard":
    case "interactive":
      await cmdWizard();
      break;
    default:
      usage();
      process.exit(cmd ? 2 : 0);
  }
})().catch((e) => {
  console.error("[oblivious-config] FATAL: " + e.message);
  process.exit(1);
});
