@echo off
echo Building ObliviousBridge.dll...

cl /LD /EHsc /DOBLIVIOUSBRIDGE_EXPORTS ^
   ObliviousBridge.cpp pch.cpp dllmain.cpp ^
   /link /DEF:ObliviousBridge.def ^
   /OUT:ObliviousBridge.dll

if %ERRORLEVEL% EQU 0 (
    echo Build successful: ObliviousBridge.dll created
) else (
    echo Build failed
)

pause