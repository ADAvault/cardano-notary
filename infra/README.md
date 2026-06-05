# cardano-notary — infra / deploy (preview test stack)

**Status: MOTHBALLED 2026-06-05** (CEO decision — Telocron is the priority;
resurrect later in the year if it makes sense). This directory captures the
runtime config that previously lived **only on the hosts** (not version
controlled), so the stack can be cleanly restarted. Nothing here runs today.

## What the deployment was

The Phase-1 notary test stack, supporting on-chain notarisation experiments:

| Component | Host | Role |
|---|---|---|
| **Ogmios** (`:1337`, docker) | vducdn59 (preview BPN, Skylarks) | WebSocket bridge to the preview cardano-node — the notary TS code's chain interface |
| **Kupo** (`:1442`, docker) | vducdn59 | UTxO/datum indexer, filtered to the notary policy IDs (the `--match` set) |
| **cardano-submit-api** (`:8090`/`:8091`, CNTools systemd) | vducdn59 | tx submission endpoint |
| **socat N2C bridge** (`:6000`) | the 6 mainnet relays | exposes each relay's `node.socket` over TCP so a mainnet **Ogmios** host can dial in |
| **Ogmios (mainnet)** | vduogm51 (Skylarks, pdukvm15) + vduogm81 (Mews DR, .3.42) | consumed the relay `:6000` N2C bridges |

cardano-node + mithril-signer on vducdn59, and cardano-node on the relays, are
the Cardano baseline — they **stayed up**; only the notary-specific bits above
were mothballed.

## Restart recipe

1. **vducdn59 chain services** — recreate the two containers:
   - `sh cdn59-ogmios.run.sh`
   - `sh cdn59-kupo.run.sh`  (re-syncs from origin; the kupo-db volume may have
     been removed — first sync is slow but unattended)
   - submit-api is CNTools-managed: `sudo systemctl start cnode-submit-api.service`
2. **Mainnet Ogmios path** (only if the notary needs mainnet chain data):
   - Power on the Ogmios VMs (vduogm51 / vduogm81 — see VM state below).
   - On each of the 6 relays: `sudo systemctl enable --now socat-n2c.service`
     (unit captured as `relays-socat-n2c.service`).
   - Reinstate the relay `:6000` firewall allows — see `relays-6000-firewall.md`
     and re-add to the er4 state + `scripts/ufw-iac/canonical.py` (the canonical
     drops `:6000` while mothballed).
3. Re-point the notary TS config at the restarted Ogmios/Kupo endpoints.

## Mothball teardown record (2026-06-05)

- vducdn59: `docker rm -f ogmios kupo`; **kupo-db volume removed** (rebuildable
  from origin via `--since origin` — no cruft); `cnode-submit-api.service`
  stopped + disabled. cnode + mithril-signer **kept running**. UFW then enabled
  (cdn59 is now a standard preview-relay + mithril — GH#63/#28).
- 6 relays: `socat-n2c.service` stopped + disabled; relay `:6000` ufw allow
  removed; relays converged to the canonical UFW set (GH#58 done).
- er4: no router `:6000` rule existed (it was host-UFW only) — nothing to remove.
- **VMs already powered off, autostart disabled (disks intact — NOT deleted):**
  vduogm51 (pdukvm15), vduogm81 (pdukvm18). Restart = power on; their on-disk
  Ogmios config is preserved (not re-captured here).
- DNS entries for vduogm51/81/vducdn59 **kept** (VMs only powered off).

## Captured because it was host-only (not in any repo)
- The Kupo `--match` policy-ID set (13 IDs) — only one was in `contract/plutus.json`.
- The ogmios + kupo `docker run` invocations (no compose existed).
- `socat-n2c.service` (the relay N2C bridge unit) + its firewall dependency.
