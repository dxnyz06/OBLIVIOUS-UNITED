#include "pch.h"
#include "ObliviousBridge.h"
#include <windows.h>
#include <string>
#include <mutex>

static std::mutex g_mutex;
static std::string g_lastError;
static HANDLE g_pipeHandle = INVALID_HANDLE_VALUE;
static const wchar_t* PIPE_NAME = L"\\\\.\\pipe\\OBLIVIOUS_AI_BRIDGE";

void SetLastError(const std::string& error) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_lastError = error;
    OutputDebugStringA(("[ObliviousBridge] " + error).c_str());
}

std::string WStringToString(const std::wstring& wstr) {
    if (wstr.empty()) return std::string();
    int size_needed = WideCharToMultiByte(CP_UTF8, 0, &wstr[0], (int)wstr.size(), NULL, 0, NULL, NULL);
    std::string strTo(size_needed, 0);
    WideCharToMultiByte(CP_UTF8, 0, &wstr[0], (int)wstr.size(), &strTo[0], size_needed, NULL, NULL);
    return strTo;
}

std::wstring StringToWString(const std::string& str) {
    if (str.empty()) return std::wstring();
    int size_needed = MultiByteToWideChar(CP_UTF8, 0, &str[0], (int)str.size(), NULL, 0);
    std::wstring wstrTo(size_needed, 0);
    MultiByteToWideChar(CP_UTF8, 0, &str[0], (int)str.size(), &wstrTo[0], size_needed);
    return wstrTo;
}

extern "C" {

OBLIVIOUSBRIDGE_API int InitializeBridge() {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    try {
        if (g_pipeHandle != INVALID_HANDLE_VALUE) {
            CloseHandle(g_pipeHandle);
        }
        
        // Wait for pipe to be available
        if (!WaitNamedPipeW(PIPE_NAME, 5000)) {
            SetLastError("Named pipe not available");
            return 0;
        }
        
        g_pipeHandle = CreateFileW(
            PIPE_NAME,
            GENERIC_READ | GENERIC_WRITE,
            0,
            NULL,
            OPEN_EXISTING,
            0,
            NULL
        );
        
        if (g_pipeHandle == INVALID_HANDLE_VALUE) {
            SetLastError("Failed to connect to named pipe");
            return 0;
        }
        
        SetLastError("Bridge initialized successfully");
        return 1;
    }
    catch (...) {
        SetLastError("Exception during bridge initialization");
        return 0;
    }
}

OBLIVIOUSBRIDGE_API int CleanupBridge() {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    try {
        if (g_pipeHandle != INVALID_HANDLE_VALUE) {
            CloseHandle(g_pipeHandle);
            g_pipeHandle = INVALID_HANDLE_VALUE;
        }
        
        SetLastError("Bridge cleaned up successfully");
        return 1;
    }
    catch (...) {
        SetLastError("Exception during bridge cleanup");
        return 0;
    }
}

OBLIVIOUSBRIDGE_API int ProcessAIRequest(
    const char* requestJson,
    char* responseBuffer,
    int bufferSize,
    int timeoutMs) {
    
    std::lock_guard<std::mutex> lock(g_mutex);
    
    try {
        if (g_pipeHandle == INVALID_HANDLE_VALUE) {
            SetLastError("Bridge not initialized");
            return 0;
        }
        
        if (!requestJson || !responseBuffer || bufferSize <= 0) {
            SetLastError("Invalid parameters");
            return 0;
        }
        
        // Write request
        DWORD bytesWritten;
        std::string request(requestJson);
        request += '\0'; // Null terminator
        
        if (!WriteFile(g_pipeHandle, request.c_str(), (DWORD)request.length(), &bytesWritten, NULL)) {
            SetLastError("Failed to write request to pipe");
            return 0;
        }
        
        if (!FlushFileBuffers(g_pipeHandle)) {
            SetLastError("Failed to flush pipe");
            return 0;
        }
        
        // Read response
        DWORD bytesRead;
        char buffer[4096];
        
        if (!ReadFile(g_pipeHandle, buffer, sizeof(buffer) - 1, &bytesRead, NULL)) {
            SetLastError("Failed to read response from pipe");
            return 0;
        }
        
        buffer[bytesRead] = '\0';
        
        // Copy to output buffer
        int copySize = min((int)strlen(buffer), bufferSize - 1);
        strncpy_s(responseBuffer, bufferSize, buffer, copySize);
        responseBuffer[copySize] = '\0';
        
        SetLastError("Request processed successfully");
        return 1;
    }
    catch (...) {
        SetLastError("Exception during request processing");
        return 0;
    }
}

OBLIVIOUSBRIDGE_API int IsBridgeHealthy() {
    std::lock_guard<std::mutex> lock(g_mutex);
    return (g_pipeHandle != INVALID_HANDLE_VALUE) ? 1 : 0;
}

OBLIVIOUSBRIDGE_API int GetLastError(char* errorBuffer, int bufferSize) {
    std::lock_guard<std::mutex> lock(g_mutex);
    
    try {
        if (!errorBuffer || bufferSize <= 0) {
            return 0;
        }
        
        int copySize = min((int)g_lastError.length(), bufferSize - 1);
        strncpy_s(errorBuffer, bufferSize, g_lastError.c_str(), copySize);
        errorBuffer[copySize] = '\0';
        
        return 1;
    }
    catch (...) {
        return 0;
    }
}

}