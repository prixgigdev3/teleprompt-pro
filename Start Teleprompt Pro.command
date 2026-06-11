#!/bin/bash
# Double-click this file to launch Teleprompt Pro.
# It starts a tiny local web server and opens the app in your browser.

cd "$(dirname "$0")"
PORT=8347

# If the server is already running, just open the app.
if ! lsof -i :$PORT >/dev/null 2>&1; then
  nohup python3 server.py $PORT >/dev/null 2>&1 &
  sleep 1
fi

URL="http://localhost:$PORT"
open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL"

echo "Teleprompt Pro is running at $URL"
echo "You can close this window."
