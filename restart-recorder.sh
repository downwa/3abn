#!/bin/sh

rec=$(ps waxf | grep -v grep | grep mpv.*dump)
if [ "$rec" != "" ]; then
	s=$(echo "3600-($(date +%s)%3600)-3" | bc)
	echo "Sleeping $s seconds until top of hour recorder restart"
	sleep $s
else
	echo "No recording in process.  Restarting now..."
fi
systemctl restart --user threeabn-recorder
journalctl --user -u threeabn-recorder -f
