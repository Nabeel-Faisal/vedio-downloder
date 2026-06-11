#!/bin/sh
set -e

echo "==> Updating yt-dlp and bgutil plugin..."
python3 -m pip install --break-system-packages -q -U yt-dlp bgutil-ytdlp-pot-provider || echo "pip update failed, continuing with installed versions"

echo "==> Starting bgutil PO token provider on :4416..."
node /opt/bgutil-pot/server/build/main.js &

# Wait up to 30s for the bgutil server to be ready before accepting traffic.
# Without this wait, the first YouTube request races against server startup
# and gets no PO token, causing the "confirm you're not a bot" error.
echo "==> Waiting for bgutil server to be ready..."
i=0
while [ $i -lt 30 ]; do
    if curl -sf http://127.0.0.1:4416/ping >/dev/null 2>&1; then
        echo "==> bgutil PO token server is ready!"
        break
    fi
    sleep 1
    i=$((i + 1))
done

if [ $i -eq 30 ]; then
    echo "WARNING: bgutil server did not start in 30s — YouTube may still require sign-in"
fi

echo "==> Starting main server..."
exec node server.js
