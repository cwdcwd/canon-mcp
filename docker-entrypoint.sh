#!/bin/sh
set -e

# SCANNER_HOST lets the container find the printer without broadcast discovery,
# which is what you want on a bridge network. Accepts an IP or hostname.
if [ -n "$SCANNER_HOST" ]; then
  conf=/tmp/pixma.conf
  {
    echo "# generated at container start from SCANNER_HOST"
    echo "bjnp://$SCANNER_HOST"
  } > "$conf"
  # SANE reads backend config from SANE_CONFIG_DIR first
  mkdir -p /tmp/sane.d
  cp /etc/sane.d/*.conf /tmp/sane.d/ 2>/dev/null || true
  cp "$conf" /tmp/sane.d/pixma.conf
  export SANE_CONFIG_DIR=/tmp/sane.d
fi

exec "$@"
