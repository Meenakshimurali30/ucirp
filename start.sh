#!/bin/sh
# macOS / Linux: run  sh start.sh  then open http://localhost:8080
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Install Node.js (LTS) from https://nodejs.org first."; exit 1; }
node server.js
