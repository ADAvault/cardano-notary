# Relay :6000 firewall (N2C bridge) — captured 2026-06-05 (GH#63)

The socat N2C bridge on each relay (:6000) needs inbound allows from the Ogmios host.
Removed during mothball; reinstate on restart.

## Host UFW (per relay, cardano@)
- Skylarks relays (cdn12/23/37/48): `ufw allow from 192.168.2.0/24 to any port 6000 proto tcp comment 'vduogm51 N2C'`
- Mews relays (cdn66/87): `ufw allow from 192.168.3.42 to any port 6000 proto tcp comment 'vduogm81 N2C'`

## er4 (pnuerx01 fw rules) — the canonical UFW (scripts/ufw-iac/canonical.py) drops
:6000 while mothballed (GH#58). On restart, re-add the :6000 rule to the relay role.

## er4 inter-VLAN accepts (web VLAN -> relay/DMZ subnet) for Ogmios/Kupo

The notary app (web VLAN) reached ogmios:1337 + kupo:1442 on vducdn59 (relay subnet)
via these router accepts. Removed during mothball (2026-06-05); reinstate on restart
by re-adding to the er4 state files + `er4-configure` apply (ABSOLUTE-IaC).

| Router | Chains | src | dst | ports |
|---|---|---|---|---|
| pnuerx01 (Skylarks) | WEB_OUT (fw-web 30/40) + DMZ (fw-dmz 30/40) | 192.168.10.0/24 | 192.168.2.0/24 | 1337 (ogmios), 1442 (kupo) |
| pnuerx02 (Mews) | WEB_OUT (fw-web 40/50) + DMZ (fw-dmz 220/230) | 192.168.11.0/24 | 192.168.3.0/24 | 1337 (ogmios), 1442 (kupo) |
