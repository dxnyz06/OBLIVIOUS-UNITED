/*
 * AiMindBridge.cpp
 * Minimal DLL wrapper: MT4 EA <-> AiMindBridge.Server EXE via named pipe.
 *
 * Design principles:
 *   - Zero API keys
 *   - Zero trading logic
 *   - Zero AI computation
 *   - Only pipe I/O: forward request, receive response
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "AiMindBridge.h"

static const char* PIPE_NAME    = "\\\\.\\pipe\\OBLIVIOUS_AIPC";
static const char* VERSION_STR  = "AiMindBridge DLL v2.0.0";
static const DWORD TIMEOUT_MS   = 3000;
static const DWORD QUERY_TIMEOUT_MS = 5000;

/* Open a connection to the named pipe, send request, read response, close. */
AIBRIDGE_API int __stdcall AiBridge_Query(
    const char* requestJson,
    char*       responseOut,
    int         responseMaxLen)
{
    if (!requestJson || !responseOut || responseMaxLen <= 0)
        return 0;

    // Attempt to connect to the pipe
    HANDLE hPipe = CreateFileA(
        PIPE_NAME,
        GENERIC_READ | GENERIC_WRITE,
        0,
        NULL,
        OPEN_EXISTING,
        0,
        NULL);

    if (hPipe == INVALID_HANDLE_VALUE)
    {
        // Pipe not available — bridge EXE not running
        strncpy_s(responseOut, responseMaxLen,
            "{\"Success\":false,\"Error\":\"Pipe not available\"}", _TRUNCATE);
        return 0;
    }

    // Use byte read mode (server operates in byte mode)
    DWORD dwMode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(hPipe, &dwMode, NULL, NULL);

    // Write request (append newline as message delimiter)
    DWORD cbRequest = (DWORD)strlen(requestJson);
    DWORD written   = 0;
    char newline    = '\n';

    BOOL ok = WriteFile(hPipe, requestJson, cbRequest, &written, NULL);
    if (ok) WriteFile(hPipe, &newline, 1, &written, NULL);

    if (!ok)
    {
        CloseHandle(hPipe);
        strncpy_s(responseOut, responseMaxLen,
            "{\"Success\":false,\"Error\":\"Write failed\"}", _TRUNCATE);
        return 0;
    }

    // Read response (loop until newline or buffer full)
    DWORD totalRead = 0;
    while (totalRead < (DWORD)(responseMaxLen - 1))
    {
        DWORD rd = 0;
        BOOL readOk = ReadFile(hPipe, responseOut + totalRead,
                               responseMaxLen - 1 - (int)totalRead, &rd, NULL);
        if (!readOk || rd == 0)
            break;
        totalRead += rd;
        if (responseOut[totalRead - 1] == '\n')
            break; // complete line received
    }
    CloseHandle(hPipe);

    if (totalRead == 0)
    {
        strncpy_s(responseOut, responseMaxLen,
            "{\"Success\":false,\"Error\":\"Read failed\"}", _TRUNCATE);
        return 0;
    }

    responseOut[totalRead] = '\0';
    // Strip trailing newline/CR if present
    while (totalRead > 0 && (responseOut[totalRead - 1] == '\n' || responseOut[totalRead - 1] == '\r'))
        responseOut[--totalRead] = '\0';

    return 1;
}

AIBRIDGE_API int __stdcall AiBridge_IsConnected(void)
{
    // Quick existence check: attempt WaitNamedPipe with minimal timeout
    BOOL available = WaitNamedPipeA(PIPE_NAME, 50); // 50ms timeout
    return available ? 1 : 0;
}

AIBRIDGE_API void __stdcall AiBridge_Version(char* outBuf, int maxLen)
{
    if (outBuf && maxLen > 0)
        strncpy_s(outBuf, maxLen, VERSION_STR, _TRUNCATE);
}

/* Query news status via a lightweight pipe request.
 * Returns severity (0=none,1=low,2=med,3=high), minutesToEvent, blockTrading. */
AIBRIDGE_API int __stdcall AiBridge_GetNewsStatus(
    const char* symbol,
    int*        severity,
    int*        minutesToEvent,
    int*        blockTrading)
{
    if (!symbol || !severity || !minutesToEvent || !blockTrading)
        return 0;

    char request[256];
    snprintf(request, sizeof(request),
        "{\"Symbol\":\"%s\",\"StrategyName\":\"NEWS_QUERY\",\"Direction\":0}", symbol);

    char response[4096];
    int ok = AiBridge_Query(request, response, sizeof(response));
    if (!ok) {
        *severity = 0;
        *minutesToEvent = 9999;
        *blockTrading = 0;
        return 0;
    }

    // Minimal parse for key fields
    *severity = 0;
    *minutesToEvent = 9999;
    *blockTrading = 0;

    const char* p;
    p = strstr(response, "\"NewsImpactLevel\":");
    if (p) *severity = atoi(p + 18);
    p = strstr(response, "\"MinutesToEvent\":");
    if (p) *minutesToEvent = atoi(p + 17);
    p = strstr(response, "\"NewsBlockNewEntries\":true");
    if (p) *blockTrading = 1;

    return 1;
}

/* DLL entry point */
BOOL APIENTRY DllMain(HMODULE hModule, DWORD ul_reason_for_call, LPVOID lpReserved)
{
    (void)hModule;
    (void)ul_reason_for_call;
    (void)lpReserved;
    return TRUE;
}
