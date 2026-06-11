#!/bin/sh
# Update yt-dlp and the PO token plugin to the latest version at startup
python3 -m pip install --break-system-packages -U yt-dlp bgutil-ytdlp-pot-provider || true

# Start the bgutil PO token provider server (listens on 127.0.0.1:4416).
# yt-dlp's bgutil plugin auto-discovers it there and attaches PO tokens to
# YouTube requests, which is what gets past the "confirm you're not a bot" wall.
node /opt/bgutil-pot/server/build/main.js &

exec node server.js
