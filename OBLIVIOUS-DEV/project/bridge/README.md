# OBLIVIOUS-DEV/project/bridge/

Reserved for live C++ / native bridge components.

The current architecture has no live C++ bridge — the EA <-> hub link
is ZeroMQ over TCP/127.0.0.1.  Legacy bridge components (the named-pipe
based OBLIVIOUS_AI_BRIDGE DLL etc.) live under ../legacy-frozen/.

