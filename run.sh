#!/usr/bin/env bash

set +e

EXIT_FILE="/tmp/chomens_exit_code"
TMUX_STOPPED="/tmp/chomens_tmux_stopped"

rm -f "$EXIT_FILE" "$TMUX_STOPPED"

# ============================================================
# Configuration
# ============================================================

PREFIX="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"

sed \
  -e "s|__DB_PASSWORD__|${DB_PASSWORD}|g" \
  -e "s|__DISCORD_TOKEN__|${DISCORD_TOKEN}|g" \
  -e "s|__DFNGBOOM__|${DFNGBOOM}|g" \
  -e "s|__PREFIX__|${PREFIX}|g" \
  config.example.yml > config.yml

# ============================================================
# Verify JAR
# ============================================================

if [ ! -f chomens.jar ]; then
    echo "ERROR: chomens.jar not found"
    exit 1
fi

if ! jar tf chomens.jar >/dev/null 2>&1; then
    echo "ERROR: chomens.jar is invalid"
    exit 1
fi

echo "Jar OK"

# ============================================================
# Install tools
# ============================================================

if ! command -v ttyd >/dev/null 2>&1; then
    echo "Installing ttyd..."

    sudo curl -fsSL \
      -o /usr/local/bin/ttyd \
      https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64

    sudo chmod +x /usr/local/bin/ttyd
fi

if ! command -v cloudflared >/dev/null 2>&1; then
    echo "Installing cloudflared..."

    curl -fsSL \
      -o /tmp/cloudflared.deb \
      https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb

    sudo dpkg -i /tmp/cloudflared.deb
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "Installing FFmpeg..."

    sudo apt-get update
    sudo apt-get install -y ffmpeg
fi

echo "FFmpeg:"
ffmpeg -version | head -n 1

echo "Node:"
node -v

echo "NPM:"
npm -v

# ============================================================
# Replacement timer
# ============================================================

(
    DELAY=$((18000 + RANDOM % 21600))

    echo "Replacement scheduled in $DELAY seconds"

    sleep "$DELAY"

    echo "Requesting graceful shutdown"

    curl -fsS \
      -X POST \
      -H "Authorization: Bearer ${PAT_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/cancel" \
      || true

    sleep 5

    echo "Starting replacement"

    curl -fsS \
      -X POST \
      -H "Authorization: Bearer ${PAT_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/run-bot.yml/dispatches" \
      -d '{"ref":"main"}' \
      || true

    echo "Replacement started"
) &

TIMER_PID=$!

# ============================================================
# Start ChomeNS
# ============================================================

cat > /tmp/run-chomens.sh <<'EOF'
#!/usr/bin/env bash

java -Xms12G -Xmx12G \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=100 \
  -XX:+ParallelRefProcEnabled \
  -XX:+AlwaysPreTouch \
  -XX:+DisableExplicitGC \
  -jar chomens.jar

CODE=$?

echo "$CODE" > /tmp/chomens_exit_code

exit "$CODE"
EOF

chmod +x /tmp/run-chomens.sh

tmux new-session \
  -d \
  -s chomens \
  "/tmp/run-chomens.sh; touch /tmp/chomens_tmux_stopped"

# ============================================================
# Remote terminal
# ============================================================

ttyd -W -p 7681 \
  tmux attach -t chomens \
  >/dev/null 2>&1 &

TTYD_PID=$!

# ============================================================
# Auth proxy
# ============================================================

node auth-proxy.js \
  >/dev/null 2>&1 &

AUTH_PID=$!

# ============================================================
# Cloudflare
# ============================================================

cloudflared tunnel \
  --no-autoupdate run \
  --token "${CF_TUNNEL_TOKEN}" \
  >/dev/null 2>&1 &

CF_PID=$!

echo "Services started"

# ============================================================
# Shutdown
# ============================================================

shutdown() {
    echo
    echo "Shutdown requested"

    # Stop replacement timer.
    if [ -n "${TIMER_PID:-}" ]; then
        kill "$TIMER_PID" 2>/dev/null || true
    fi

    # Stop auxiliary services.
    kill "${TTYD_PID:-}" 2>/dev/null || true
    kill "${AUTH_PID:-}" 2>/dev/null || true
    kill "${CF_PID:-}" 2>/dev/null || true

    # Gracefully stop ChomeNS.
    if tmux has-session -t chomens 2>/dev/null; then

        echo "Sending graceful shutdown..."

        tmux send-keys \
          -t chomens \
          C-u \
          2>/dev/null || true

        tmux send-keys \
          -t chomens \
          ".stop restarting, can take up to a minute" \
          2>/dev/null || true

        tmux send-keys \
          -t chomens \
          Enter \
          2>/dev/null || true
    fi

    echo "Waiting for graceful shutdown..."

    for ((i=0; i<60; i++)); do

        if [ -f "$EXIT_FILE" ] || [ -f "$TMUX_STOPPED" ]; then
            echo "Bot shut down gracefully"
            return 0
        fi

        sleep 1
    done

    echo "Graceful shutdown timed out"

    if tmux has-session -t chomens 2>/dev/null; then
        tmux send-keys -t chomens C-c 2>/dev/null || true
        sleep 1
        tmux kill-session -t chomens 2>/dev/null || true
    fi
}

trap shutdown TERM INT

# ============================================================
# Monitor bot
# ============================================================

while [ ! -f "$EXIT_FILE" ]; do

    if ! pgrep -f "java.*chomens.jar" >/dev/null 2>&1; then
        echo "Java process disappeared"

        echo 1 > "$EXIT_FILE"
        break
    fi

    sleep 5
done

# ============================================================
# Exit code
# ============================================================

CODE="$(cat "$EXIT_FILE" 2>/dev/null || echo 1)"

echo "Bot process exited with code $CODE"

shutdown

# ============================================================
# Start replacement
# ============================================================

DELAY=$((RANDOM % 6))

echo "Starting replacement in $DELAY seconds"

sleep "$DELAY"

echo "Dispatching replacement workflow"

curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${PAT_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/run-bot.yml/dispatches" \
  -d '{"ref":"main"}' \
  || true

echo "Replacement requested"

exit "$CODE"
