#!/bin/bash
# Monday automation — runs every Monday morning.
# Order: generate.js (updates targets from tracker) → monday_list.js (sends lists to Slack)

LOG="/Users/mateocortazar/ghl-dashboard/logs/monday_run.log"
mkdir -p /Users/mateocortazar/ghl-dashboard/logs

echo "=== Monday run started: $(date) ===" >> "$LOG"

echo "[1/2] Running generate.js..." >> "$LOG"
/usr/local/bin/node /Users/mateocortazar/ghl-dashboard/generate.js >> "$LOG" 2>&1
if [ $? -ne 0 ]; then
  echo "ERROR: generate.js failed. Aborting monday_list.js." >> "$LOG"
  exit 1
fi

echo "[2/2] Running monday_list.js..." >> "$LOG"
/usr/local/bin/node /Users/mateocortazar/ghl-dashboard/monday_list.js >> "$LOG" 2>&1

echo "=== Monday run finished: $(date) ===" >> "$LOG"
