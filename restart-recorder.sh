#!/bin/sh

s=$(echo "3600-($(date +%s)%3600)-3" | bc)
echo "Sleeping $s until top of hour recorder restart"
sleep $s
systemctl restart --user threeabn-recorder
journalctl --user -u threeabn-recorder -f
