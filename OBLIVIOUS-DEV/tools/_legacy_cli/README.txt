OBLIVIOUS — _legacy_cli (archiviato)

Questi launcher .bat sono il vecchio percorso CMD/CLI per la gestione di:
- config.enc (passphrase + API key)
- wizard di setup interattivo

NON sono più il percorso utente ufficiale.
La UX ufficiale è esclusivamente la GUI:
  - OBLIVIOUS-DEV/build/electron/setup-dev/OBLIVIOUS SETUP DEV.exe
  - OBLIVIOUS-VPS/runtime/setup-vps/OBLIVIOUS SETUP VPS.exe

Restano qui solo come fallback tecnico per debug/automazione headless.
Il backend Node (oblivious-config.js, oblivious-setup.js) resta in
OBLIVIOUS-DEV/tools/operator/ come motore interno — niente di nuovo
deve passare di qua per l'operatore finale.
