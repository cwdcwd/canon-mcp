# canon-mcp

MCP server for a Canon PIXMA MX490 over the network, built on SANE's `pixma`
backend (Canon's BJNP protocol). macOS has no working scanner driver for this
model, so this talks to it directly.

Tools: `list_scanners`, `scanner_options`, `scan_document`.

## Run it

Three entry points, same tools behind all of them:

| Command | Transport | Use for |
| --- | --- | --- |
| `node src/cli.ts` | none | scanning from a shell |
| `node src/server.ts` | stdio | Claude Desktop / Claude Code on the same machine |
| `node src/http.ts` | Streamable HTTP | the container, remote agents |

Node 22.18+, no build step. Add `NODE_NO_WARNINGS=1` to silence the
type-stripping notice.

## Container (Raspberry Pi)

Needs a 64-bit OS (`uname -m` → `aarch64`) and Docker.

```bash
echo "MCP_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
curl -s localhost:3000/healthz
```

`compose.yaml` uses bridge networking with `SCANNER_HOST` set: the entrypoint
writes that address into `pixma.conf`, so the container reaches the printer
without broadcast discovery. This is the tested path — built for arm64 and
scanned from inside the container. Switching to `network_mode: host` (Linux
only) gets you discovery, if you'd rather not pin the address.

Environment:

| Variable | Meaning |
| --- | --- |
| `SCANNER_HOST` | Printer IP or hostname; written to `pixma.conf` at startup |
| `SCAN_DEVICE` | Full SANE device name; skips discovery, a few seconds faster |
| `SCAN_OUTPUT_DIR` | Where scans land (`/scans` in the container) |
| `MCP_TOKEN` | Bearer token required on every request; no auth if unset |
| `PORT`, `HOST`, `MCP_PATH` | Listener settings (`3000`, `0.0.0.0`, `/mcp`) |

Reserve the printer's IP on your router. If it moves, `SCAN_DEVICE` and
`SCANNER_HOST` both go stale.

## Connecting an agent

Local, over stdio:

```json
"canon": {
  "command": "node",
  "args": ["/path/to/canonMCP/src/server.ts"],
  "env": { "SCAN_DEVICE": "pixma:MX490_192.168.0.199", "NODE_NO_WARNINGS": "1" }
}
```

Remote, against the container:

```json
"canon": {
  "type": "http",
  "url": "http://pi.local:3000/mcp",
  "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
}
```

The HTTP server is stateless: every request gets a fresh MCP server and
transport, so restarts and multiple agents don't interfere.

Scans are saved on the host running the server. An agent elsewhere can get the
bytes back inline with `return_file: true`, which is capped at ~4MB — use
`jpeg` or a lower resolution for that.

## Notes

- **macOS Local Network.** On a Mac, whichever app launches the server needs
  Local Network permission, or scanimage's UDP is blocked and the process dies
  with SIGPIPE. Terminal.app works; iTerm may need a restart. Linux has no
  such check, which is one reason the Pi is a better host.
- **Speed.** 300 dpi color flatbed takes about 45 seconds over Wi-Fi, 75 dpi
  about 15.
- **ADF.** `source: "ADF"` scans the whole feeder and returns one file per
  page. Untested.
- **Printing** isn't implemented. The MX490 supports AirPrint, so a print tool
  would go through CUPS (`lp`, `lpstat`, `cancel`) rather than SANE.
