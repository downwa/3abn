#!/bin/sh

systemctl restart --user threeabn-player; 
journalctl --user -u threeabn-player -f
