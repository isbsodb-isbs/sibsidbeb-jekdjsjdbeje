#!/bin/sh

while true
do
    echo "[Eval Watchdog] Starting eval server"

    node eval-server.js

    CODE=$?

    echo "[Eval Watchdog] Eval exited with $CODE"

    sleep 2

    echo "[Eval Watchdog] Restarting"
done
