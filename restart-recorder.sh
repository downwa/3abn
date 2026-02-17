#!/bin/sh

s=$(echo "3600-($(date +%s)%3600)-3" | bc); sleep $s; systemctl restart --user threeabn-recorder; journalctl --user -u threeabn-recorder -f
