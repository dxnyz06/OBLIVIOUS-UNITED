OBLIVIOUS-VPS/runtime/operator-tools/

UX UFFICIALE per password e API key sul VPS:
  ..\setup-vps\OBLIVIOUS SETUP VPS.exe   (GUI Electron)

Questa cartella contiene SOLO utilita' minori non coperte dalla GUI:

  Run-Device-ID.bat     -> stampa il device_id da inviare al licensing operator
  Run-License-Check.bat -> verifica license.lic + public_key.pem

NON contiene piu':
  Run-Oblivious-Setup.bat   (rimpiazzato da OBLIVIOUS SETUP VPS.exe)
  Run-Config-Manager.bat    (rimpiazzato da OBLIVIOUS SETUP VPS.exe)
  oblivious-setup.js        (wizard CLI archiviato in DEV)
  oblivious-config.js       (CLI di config; rimasto in OBLIVIOUS-DEV come backend)

Requires: Node.js LTS in PATH (per device-id / license-check).

Vendor/*.js sono copie verbatim da oblivious-hub/src/services per installazioni VPS offline.
NESSUNA private key, NESSUN license generator: restano in OBLIVIOUS-PRIVATE/.
