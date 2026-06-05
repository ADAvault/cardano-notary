#!/bin/sh
# cdn59 preview Ogmios -- captured 2026-06-05 before mothball (GH#63).
# Runs on vducdn59 (preview node). No compose existed; this is the bare `docker run`.
docker run -d --name ogmios --restart unless-stopped \
  -p 1337:1337 \
  -v /opt/cardano/cnode/sockets:/ipc \
  -v /opt/cardano/cnode/files:/config \
  cardanosolutions/ogmios:latest \
  --node-socket /ipc/node.socket --node-config /config/p2p-config.json --host 0.0.0.0
