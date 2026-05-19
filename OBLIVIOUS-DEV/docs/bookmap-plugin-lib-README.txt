# OBLIVIOUS Bookmap Bridge — SDK drop-in checklist
#
# The build expects two jars from your Bookmap installation:
#
#   - bm-l1api.jar           (com.bookmap.api:api-core:jar:local)
#   - bm-simplified-api.jar  (com.bookmap.api:api-simplified:jar:local)
#
# WHERE TO FIND THEM
# ------------------
# Windows (default install): C:\Bookmap\<version>\lib\
#   examples:                C:\Bookmap\v7.6.0\lib\bm-l1api.jar
#                            C:\Bookmap\v7.6.0\lib\bm-simplified-api.jar
#
# macOS:                     /Applications/Bookmap.app/Contents/Resources/lib/
#
# Linux:                     ~/.local/share/bookmap/<version>/lib/
#
# HOW TO WIRE THEM
# ----------------
# Pick exactly ONE of these three options:
#
# (A) Copy the two jars into THIS directory (bookmap-plugin/lib/), then:
#       cd bookmap-plugin
#       mvn package
#
# (B) Set the env var, then:
#       $env:BOOKMAP_HOME = "C:\Bookmap\v7.6.0"
#       cd bookmap-plugin
#       mvn package
#
# (C) Pass on the Maven command line (highest priority):
#       cd bookmap-plugin
#       mvn -DbookmapHome="C:/Bookmap/v7.6.0" package
#
# VERIFY
# ------
# Successful build prints:
#       [INFO] BUILD SUCCESS
# and produces:
#       bookmap-plugin/target/oblivious-bookmap-bridge-1.0.0.jar
#
# INSTALL
# -------
# Copy that jar into Bookmap's add-ons folder:
#   %USERPROFILE%\AppData\Roaming\Bookmap\Bookmap\addons\
# then enable "OBLIVIOUS Bridge" inside Bookmap → Add-ons.
#
# .gitignore note: only the jars are gitignored; this README is tracked.
