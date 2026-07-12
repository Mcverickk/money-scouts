#!/bin/sh
set -eu

# The official image seeds a generic config on first boot. Keep the operational
# state/auth volume, but make the non-secret Edge Desk routing config immutable
# and version-controlled on every deployment.
config_tmp="/opt/data/config.yaml.edge-desk.tmp"
cp /opt/edge-desk/config.yaml "$config_tmp"
chmod 0640 "$config_tmp"
mv "$config_tmp" /opt/data/config.yaml

exec hermes gateway run
