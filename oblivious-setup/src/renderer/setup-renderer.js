(() => {
  const api = window.obliviousSetup;

  const els = {
    unlockHintLine: document.getElementById("unlock-hint-line"),
    unlockLayer: document.getElementById("unlock-layer"),
    panelFirstRun: document.getElementById("panel-first-run"),
    panelUnlock: document.getElementById("panel-unlock"),
    firstRunHint: document.getElementById("first-run-hint"),
    frPass: document.getElementById("fr-pass"),
    frConfirm: document.getElementById("fr-confirm"),
    frBtn: document.getElementById("fr-btn"),
    frErr: document.getElementById("fr-err"),
    appLayer: document.getElementById("app-layer"),
    unlockTitle: document.getElementById("unlock-title"),
    unlockPath: document.getElementById("unlock-path"),
    unlockPass: document.getElementById("unlock-pass"),
    unlockErr: document.getElementById("unlock-err"),
    unlockBtn: document.getElementById("unlock-btn"),
    appTitle: document.getElementById("app-title"),
    primaryPath: document.getElementById("primary-path"),
    apiKeysHint: document.getElementById("api-keys-hint"),
    providerRows: document.getElementById("provider-rows"),
    secPassDev: document.getElementById("sec-pass-dev"),
    secPassVps: document.getElementById("sec-pass-vps"),
    pwDevNew: document.getElementById("pw-dev-new"),
    pwDevConfirm: document.getElementById("pw-dev-confirm"),
    pwDevSave: document.getElementById("pw-dev-save"),
    pwDevMsg: document.getElementById("pw-dev-msg"),
    pwVpsNew: document.getElementById("pw-vps-new"),
    pwVpsConfirm: document.getElementById("pw-vps-confirm"),
    pwVpsSave: document.getElementById("pw-vps-save"),
    pwVpsMsg: document.getElementById("pw-vps-msg"),
    btnExit: document.getElementById("btn-exit"),
  };

  let boot = { mode: "dev", providerMeta: [], features: {}, paths: {} };

  const uiById = {};

  function setPill(id, state) {
    const pill = uiById[id]?.pill;
    if (!pill) return;
    pill.className = "status-pill " + state;
    pill.textContent = state;
  }

  function testOutcomePill(r) {
    if (r && r.ok) return "valid";
    const reason = r && r.reason ? String(r.reason) : "";
    if (reason === "no_api_key") return "empty";
    if (
      reason === "exception" ||
      reason === "vault_unreadable" ||
      (r && r._ipcError)
    )
      return "error";
    return "invalid";
  }

  async function refreshBootstrapLabels() {
    boot = await api.bootstrap();
    els.primaryPath.textContent = boot.paths.apiKeysVault || "";
  }

  async function enterMainApp() {
    els.unlockLayer.hidden = true;
    els.appLayer.hidden = false;
    await refreshBootstrapLabels();
    await syncProvidersFromVault();
  }

  async function syncProvidersFromVault() {
    try {
      const list = await api.listProviders();
      for (const row of list) {
        const input = uiById[row.id]?.input;
        const pill = uiById[row.id]?.pill;
        if (!input || !pill) continue;
        if (input.value.trim().length > 0) {
          pill.className = "status-pill empty";
          pill.textContent = "…";
        } else {
          setPill(row.id, row.saved ? "saved" : "empty");
        }
      }
    } catch {
      /* keys vault locked */
    }
  }

  function wireProviderRow(meta) {
    const wrap = document.createElement("div");
    wrap.className = "provider-row";

    const top = document.createElement("div");
    top.className = "provider-top";

    const name = document.createElement("span");
    name.className = "provider-name";
    name.textContent = meta.label;

    const pill = document.createElement("span");
    pill.className = "status-pill empty";
    pill.textContent = "empty";

    top.appendChild(name);
    top.appendChild(pill);

    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "Incolla la chiave — Save cifra nel vault indicato sopra";
    input.autocomplete = "off";

    input.addEventListener("input", () => {
      if (!input.value.trim()) {
        syncProvidersFromVault().catch(() => {});
      } else {
        pill.className = "status-pill empty";
        pill.textContent = "…";
      }
    });

    const actions = document.createElement("div");
    actions.className = "provider-actions";

    const btnTest = document.createElement("button");
    btnTest.type = "button";
    btnTest.className = "btn small";
    btnTest.textContent = "Test";

    const btnSave = document.createElement("button");
    btnSave.type = "button";
    btnSave.className = "btn small primary";
    btnSave.textContent = "Save";

    btnTest.addEventListener("click", async () => {
      pill.className = "status-pill empty";
      pill.textContent = "…";
      try {
        const r = await api.testProvider({
          providerId: meta.id,
          apiKey: input.value,
        });
        const st = testOutcomePill(r);
        setPill(meta.id, st);
      } catch {
        setPill(meta.id, "error");
      }
    });

    btnSave.addEventListener("click", async () => {
      pill.className = "status-pill empty";
      pill.textContent = "…";
      try {
        await api.saveProvider({
          providerId: meta.id,
          apiKey: input.value,
        });
        input.value = "";
        pill.className = "status-pill saved";
        pill.textContent = "saved";
        await syncProvidersFromVault();
      } catch {
        setPill(meta.id, "error");
      }
    });

    actions.appendChild(btnTest);
    actions.appendChild(btnSave);

    wrap.appendChild(top);
    wrap.appendChild(input);
    wrap.appendChild(actions);

    els.providerRows.appendChild(wrap);
    uiById[meta.id] = { pill, input };
  }

  async function init() {
    boot = await api.bootstrap();
    document.title = boot.windowTitle;
    els.appTitle.textContent = boot.windowTitle;
    els.unlockPath.textContent =
      boot.paths.primaryVault || boot.paths.unlockVaultHint || "";

    const gate = boot.initialGate || "unlock";

    if (gate === "first-run") {
      els.panelFirstRun.hidden = false;
      els.panelUnlock.hidden = true;
      els.unlockTitle.textContent =
        boot.mode === "dev" ? "Primo avvio — vault DEV" : "Primo avvio — vault VPS";
      els.unlockHintLine.innerHTML =
        boot.mode === "dev"
          ? "Nessun vault DEV valido. Imposta passphrase per creare il file indicato sotto."
          : "Nessun vault VPS valido nel bundle. Imposta passphrase per creare il file indicato sotto.";
      els.firstRunHint.textContent =
        boot.mode === "dev"
          ? "Creazione automatica su disco — nessun passaggio manuale."
          : "Creazione automatica nel bundle — solo API Keys dopo il primo avvio.";
    } else {
      els.panelFirstRun.hidden = true;
      els.panelUnlock.hidden = false;
      els.unlockTitle.textContent = boot.windowTitle;
      if (boot.mode === "dev") {
        els.unlockHintLine.innerHTML =
          "Sblocca il <strong>vault DEV</strong> per modificare API Keys DEV e Password DEV. La Password VPS aggiorna il vault VPS nel workspace.";
      } else {
        els.unlockHintLine.innerHTML =
          "Sblocca il <strong>vault VPS</strong> solo per le API Keys — nessun cambio passphrase.";
      }
    }

    els.primaryPath.textContent = boot.paths.apiKeysVault || "";

    if (boot.mode === "dev") {
      els.apiKeysHint.textContent =
        "Solo vault DEV (percorsi sopra). Per ogni provider: Test / Save — nessun Save All né Reload. Save con campo vuoto rimuove la chiave per quel provider.";
    } else {
      els.apiKeysHint.textContent =
        "Solo vault VPS del bundle. Per ogni provider: Test / Save — nessun Save All né Reload. Save con campo vuoto rimuove la chiave per quel provider.";
    }

    if (boot.features.passwordDevSection) els.secPassDev.hidden = false;
    if (boot.features.passwordVpsSection) els.secPassVps.hidden = false;

    for (const meta of boot.providerMeta) wireProviderRow(meta);

    els.frBtn.addEventListener("click", async () => {
      els.frErr.hidden = true;
      const r = await api.createVault({
        passphrase: els.frPass.value,
        confirmPass: els.frConfirm.value,
      });
      if (!r.ok) {
        els.frErr.textContent =
          r.reason === "password_mismatch"
            ? "Le passphrase non coincidono."
            : r.reason === "vault_already_exists"
              ? "Il vault esiste già — riavvia l'app."
              : "Creazione vault fallita.";
        els.frErr.hidden = false;
        return;
      }
      els.frPass.value = "";
      els.frConfirm.value = "";
      await enterMainApp();
    });

    els.unlockBtn.addEventListener("click", async () => {
      els.unlockErr.hidden = true;
      const r = await api.unlock(els.unlockPass.value);
      if (!r.ok) {
        els.unlockErr.textContent =
          r.reason === "vault_needs_create"
            ? "Vault non inizializzato — chiudi e riapri per la creazione guidata."
            : r.reason === "empty_passphrase"
              ? "Inserisci la passphrase."
              : "Passphrase errata.";
        els.unlockErr.hidden = false;
        return;
      }
      els.unlockPass.value = "";
      await enterMainApp();
    });

    els.pwDevSave.addEventListener("click", async () => {
      els.pwDevMsg.textContent = "";
      els.pwDevMsg.className = "msg";
      try {
        const r = await api.changePasswordDev({
          newPass: els.pwDevNew.value,
          confirmPass: els.pwDevConfirm.value,
        });
        if (!r.ok) {
          els.pwDevMsg.textContent =
            r.reason === "password_mismatch"
              ? "Le passphrase non coincidono."
              : r.reason === "vault_unreadable"
                ? "Impossibile leggere il vault con la sessione corrente."
                : "Impossibile cambiare la passphrase.";
          els.pwDevMsg.className = "msg bad";
          return;
        }
        els.pwDevMsg.textContent = "Passphrase vault DEV aggiornata — Oblivious Hub DEV la richiederà al prossimo avvio.";
        els.pwDevNew.value = "";
        els.pwDevConfirm.value = "";
        await refreshBootstrapLabels();
      } catch {
        els.pwDevMsg.textContent = "Impossibile cambiare la passphrase.";
        els.pwDevMsg.className = "msg bad";
      }
    });

    els.pwVpsSave.addEventListener("click", async () => {
      els.pwVpsMsg.textContent = "";
      els.pwVpsMsg.className = "msg";
      const r = await api.changePasswordVps({
        newPass: els.pwVpsNew.value,
        confirmPass: els.pwVpsConfirm.value,
      });
      if (!r.ok) {
        els.pwVpsMsg.textContent =
          r.reason === "cancelled"
            ? "Operazione annullata."
            : r.reason === "bad_current_password"
              ? "Passphrase VPS attuale non accettata."
              : r.reason === "password_mismatch"
                ? "Le nuove passphrase non coincidono."
                : "Impossibile cambiare la passphrase VPS.";
        els.pwVpsMsg.className = "msg bad";
        return;
      }
      els.pwVpsMsg.textContent = r.created
        ? "Vault VPS creato nel workspace (`OBLIVIOUS-VPS/config/config.enc`)."
        : "Vault VPS aggiornato sul disco nel workspace (`OBLIVIOUS-VPS/config/config.enc`). È lo stesso file del bundle: dopo sync/deploy sul server, Oblivious Hub VPS richiederà la nuova passphrase.";
      els.pwVpsNew.value = "";
      els.pwVpsConfirm.value = "";
      await refreshBootstrapLabels();
    });

    els.btnExit.addEventListener("click", () => api.exitApp());
  }

  init().catch((e) => {
    console.error(e);
    els.unlockErr.textContent = "Avvio fallito (bootstrap).";
    els.unlockErr.hidden = false;
  });
})();
