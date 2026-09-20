#!/bin/sh
set -e

# --- scanner: point SANE at the printer so it needs no broadcast discovery ---
if [ -n "$SCANNER_HOST" ]; then
  mkdir -p /tmp/sane.d
  cp /etc/sane.d/*.conf /tmp/sane.d/ 2>/dev/null || true
  {
    echo "# generated at container start from SCANNER_HOST"
    echo "bjnp://$SCANNER_HOST"
  } > /tmp/sane.d/pixma.conf
  export SANE_CONFIG_DIR=/tmp/sane.d
fi

# --- printer: run cupsd and add the queue, unless printing is turned off ---
if [ "$PRINTING" != "off" ] && command -v cupsd > /dev/null; then
  PRINTER_QUEUE=${PRINTER_QUEUE:-MX490}
  PRINTER_URI=${PRINTER_URI:-${PRINTER_HOST:+ipp://$PRINTER_HOST/ipp/print}}
  export PRINTER_QUEUE PRINTER_URI

  if [ -z "$PRINTER_URI" ]; then
    echo "entrypoint: PRINTER_HOST/PRINTER_URI unset, skipping print queue" >&2
  else
    cupsd
    for i in $(seq 1 20); do
      lpstat -r > /dev/null 2>&1 && break
      sleep 0.5
    done

    if lpstat -p "$PRINTER_QUEUE" > /dev/null 2>&1; then
      echo "entrypoint: queue $PRINTER_QUEUE already present" >&2
    else
      # -m everywhere pulls the IPP Everywhere capabilities from the printer
      if lpadmin -p "$PRINTER_QUEUE" -E -v "$PRINTER_URI" -m everywhere 2>/tmp/lpadmin.err; then
        cupsenable "$PRINTER_QUEUE" 2>/dev/null || true
        cupsaccept "$PRINTER_QUEUE" 2>/dev/null || true
        lpoptions -d "$PRINTER_QUEUE" > /dev/null 2>&1 || true
        echo "entrypoint: queue $PRINTER_QUEUE -> $PRINTER_URI" >&2
      else
        echo "entrypoint: could not add queue ($(tail -1 /tmp/lpadmin.err)); printing tools will report the error" >&2
      fi
    fi
  fi
fi

exec "$@"
