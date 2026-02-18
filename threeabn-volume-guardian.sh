#!/usr/bin/env bash

# threeabn-volume-guardian.sh

SERVICE="threeabn-player"
SLEEPTIME=1    # normal polling period
COOLDOWN=30    # seconds to sleep after bumping volume

log_volume_bump() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') - Volume increased to 100 on $(ls /tmp/mpv-socket-[12] 2>/dev/null || echo 'no active players')"
}

# Initial startup
echo "$(date '+%Y-%m-%d %H:%M:%S') - Starting 3ABN Volume Guardian Service..."

# Initial volume check (startup boost)
bumped_startup=false
for skt in /tmp/mpv-socket-[12]; do
  [ -S "$skt" ] || continue
  
  volume=$(echo '{ "command": ["get_property", "volume"] }' | socat - "$skt" 2>/dev/null | grep -o '"data":[^,}]*' | cut -d: -f2 | tr -d ' ')
  
  if [ "$volume" != "100.000000" ] && [ "$volume" != "100" ]; then
    echo '{ "command": ["set_property", "volume", 100] }' | socat - "$skt"
    bumped_startup=true
  fi
done

if [ "$bumped_startup" = true ]; then
  log_volume_bump
fi

while true; do
  # Get last line from journal for the user service
  line=$(journalctl --user -u "$SERVICE" -n 1 --no-pager 2>/dev/null)

  # Check for " - Playing " marker
  if grep -q " - Playing " <<< "$line"; then
    # Extract the journal timestamp (e.g. "Feb 18 10:00:00") 
    ts_str=$(echo "$line" | awk '{print $1, $2, $3}')

    # Convert journal timestamp to epoch seconds (fix: use %b format)
    now_epoch=$(date +%s)
    log_epoch=$(date -d "$(date +%Y)-$(date -d "$ts_str" +%m)-$(date -d "$ts_str" +%d) $(echo "$ts_str" | cut -d' ' -f3-)" +%s 2>/dev/null || echo 0)
    diff=$((now_epoch - log_epoch))

    # If timestamp is between 5 and 30 seconds ago, check volumes
    if [ $diff -ge 5 ] && [ $diff -le 30 ]; then
      bumped=false
      
      for skt in /tmp/mpv-socket-[12]; do
        [ -S "$skt" ] || continue
        
        # Check current volume
        volume=$(echo '{ "command": ["get_property", "volume"] }' | socat - "$skt" 2>/dev/null | grep -o '"data":[^,}]*' | cut -d: -f2 | tr -d ' ')
        
        if [ "$volume" != "100.000000" ] && [ "$volume" != "100" ]; then
          echo '{ "command": ["set_property", "volume", 100] }' | socat - "$skt"
          bumped=true
        fi
      done
      
      if [ "$bumped" = true ]; then
        log_volume_bump
        # Avoid checking again for at least COOLDOWN seconds
        sleep $COOLDOWN
        continue
      fi
    fi
  fi

  sleep $SLEEPTIME
done

