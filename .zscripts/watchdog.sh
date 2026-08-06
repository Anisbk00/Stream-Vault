#!/bin/bash
cd /home/z/my-project
while true; do
  # dev script tees to dev.log
  bun run dev > /dev/null 2>&1
  PID=$!
  # if bun exits, wait 2s and restart
  sleep 2
done
