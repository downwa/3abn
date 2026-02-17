#!/bin/sh

systemctl restart --user threeabn-player; 
radio@radiotower:~/src/3abn$ journalctl --user -u threeabn-player -f
