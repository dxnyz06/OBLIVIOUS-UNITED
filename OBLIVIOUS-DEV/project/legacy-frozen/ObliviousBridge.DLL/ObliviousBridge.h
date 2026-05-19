#pragma once

#ifdef OBLIVIOUSBRIDGE_EXPORTS
#define OBLIVIOUSBRIDGE_API __declspec(dllexport)
#else
#define OBLIVIOUSBRIDGE_API __declspec(dllimport)
#endif

extern "C" {
    // Initialize the bridge connection
    OBLIVIOUSBRIDGE_API int InitializeBridge();
    
    // Cleanup the bridge connection
    OBLIVIOUSBRIDGE_API int CleanupBridge();
    
    // Process AI trading request
    OBLIVIOUSBRIDGE_API int ProcessAIRequest(
        const char* requestJson,
        char* responseBuffer,
        int bufferSize,
        int timeoutMs
    );
    
    // Check bridge health
    OBLIVIOUSBRIDGE_API int IsBridgeHealthy();
    
    // Get last error message
    OBLIVIOUSBRIDGE_API int GetLastError(
        char* errorBuffer,
        int bufferSize
    );
}