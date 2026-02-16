main:
	systemctl start --user threeabn-recorder
	systemctl start --user threeabn-player
	systemctl start --user ecreso-keepalive

restart-player:
	systemctl restart --user threeabn-player
	journalctl --user -u threeabn-player -f

restart-recorder:
	systemctl restart --user threeabn-recorder
	journalctl --user -u threeabn-recorder -f

restart-keepalive:
	systemctl restart --user ecreso-keepalive
	journalctl --user -u ecreso-keepalive -f

stop:
	systemctl --user disable --now threeabn-player

play:
	systemctl --user enable --now threeabn-player
