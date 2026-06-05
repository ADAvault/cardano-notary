#!/bin/sh
# cdn59 preview Kupo -- captured 2026-06-05 before mothball (GH#63).
# CRITICAL: the 13 --match policy IDs existed ONLY in the running container, not in
# the repo (only 28805a1e... is in contract/plutus.json). This is the capture.
docker run -d --name kupo --restart unless-stopped \
  -p 1442:1442 \
  -v /opt/cardano/cnode/files:/config \
  -v /opt/cardano/cnode/sockets:/ipc \
  -v kupo-db:/db \
  cardanosolutions/kupo:v2.9.0 \
  +RTS -N1 -A64m -I5 -RTS \
  --node-socket /ipc/node.socket --node-config /config/p2p-config.json \
  --host 0.0.0.0 --workdir /db --since origin --prune-utxo \
  --match 0027a6fe95fffb1a6a5a5282b98a754a9f0d7402db0a4e40cd466e5b/\* \
  --match 064b53addd46894f86faca65297c30df2ca8b26c58ebb1c320a98928/\* \
  --match 28805a1e62f43c6e25012af0256af0558a678f87ec3f628c880852f4/\* \
  --match 4343811926032064ed83ccdee1776bb91cdc64f69f3954339185b89c/\* \
  --match 4480eade5e2c99aea5f827f7db5b637e9782dbf83777a51654312bd4/\* \
  --match 452905e880d30067296ebac01b3b3c3122737d70990dd0e3552f233b/\* \
  --match 4580455bbd74967ca9eb0885e8e77cca2471e3f1d32fe05799ec1692/\* \
  --match 617e89947b9b2f4cd7a1d28862b59e551fd0a37f4ed628693cc342e4/\* \
  --match 7158b79e02a10467c1f2f3c85c7331c2fd76dc73882c3f42998c2c42/\* \
  --match 76757c5a13c33acebdbc2874dc6ea9789b76c432c800f8665c60caeb/\* \
  --match 8448c1acd90ae3e248dee57d6fa1df5de19c94393de6634837af9c10/\* \
  --match 8506b0dcb0e467574cf94d21faf939642802f5d741b9662be4d10570/\* \
  --match ef17ecd9d2fd3f828ad0f28a2743e3453ecba83615630282419a065c/\*
