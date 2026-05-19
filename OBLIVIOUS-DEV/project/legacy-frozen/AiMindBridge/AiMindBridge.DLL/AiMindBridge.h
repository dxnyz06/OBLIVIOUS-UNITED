/*
 * AiMindBridge.h
 * Minimal DLL wrapper between MT4 EA and the AiMindBridge.Server EXE.
 *
 * This DLL:
 *   - Exposes a stable C ABI for MT4 #import
 *   - Forwards JSON request to the named pipe (AiMindBridge.Server)
 *   - Returns JSON response payload to the EA
 *   - Contains NO API keys, NO trading logic, NO AI computation
 *
 * All business logic and AI computation lives in AiMindBridge.Server.
 */

#pragma once

#ifdef AIMINDBRIDGE_EXPORTS
#define AIBRIDGE_API __declspec(dllexport)
#else
#define AIBRIDGE_API __declspec(dllimport)
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Send a JSON request to the bridge EXE and receive a JSON response.
 * requestJson  : UTF-8 JSON string (BridgeRequest schema)
 * responseOut  : caller-allocated buffer to receive the JSON response
 * responseMaxLen : size of responseOut buffer in bytes
 * Returns: 1 on success, 0 on failure (pipe not connected / timeout)
 */
AIBRIDGE_API int __stdcall AiBridge_Query(
    const char* requestJson,
    char*       responseOut,
    int         responseMaxLen
);

/* Check if the bridge EXE is running and the pipe is available.
 * Returns: 1 if connected, 0 if not available
 */
AIBRIDGE_API int __stdcall AiBridge_IsConnected(void);

/* Returns the bridge version string into the provided buffer. */
AIBRIDGE_API void __stdcall AiBridge_Version(char* outBuf, int maxLen);

/* Query news status for a symbol. Lightweight pipe round-trip.
 * severity: 0=none, 1=low, 2=medium, 3=high
 * minutesToEvent: minutes until next relevant event
 * blockTrading: 1 if new entries should be blocked
 * Returns: 1 on success, 0 on failure
 */
AIBRIDGE_API int __stdcall AiBridge_GetNewsStatus(
    const char* symbol,
    int*        severity,
    int*        minutesToEvent,
    int*        blockTrading
);

#ifdef __cplusplus
}
#endif
