# canon-mcp

MCP server for a Canon PIXMA MX490 over the network, built on SANE's `pixma`
backend (Canon's BJNP protocol). macOS has no working scanner driver for this
model, so this talks to it directly.

Scanning and printing, over two interfaces on one core: an **MCP server**
(tools `list_scanners`, `scanner_options`, `list_scans`, `scan_document`,
`printer_status`, `print_file`, `print_jobs`, `cancel_print_job`,
`copy_document`; every scan on disk as a `scan://<filename>` resource) and a
**REST API** under `/api` for everything that doesn't speak MCP.

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
| `PUBLIC_BASE_URL` | Base for download URLs behind a proxy or tunnel |
| `PRINTER_HOST` | Printer address for the CUPS queue (or set `PRINTER_URI`) |
| `PRINTER_QUEUE` | Queue name, default `MX490` |
| `PRINTING` | `off` skips cupsd entirely (scan-only container) |

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

## Getting the scan back

Scans are written to `SCAN_OUTPUT_DIR` on the host running the server. There
are three ways to get the bytes from there to an agent somewhere else.

**1. Inline, with the response.** Pass `return_file: true` to `scan_document`.
PNG and JPEG come back as `image` content blocks that clients render; PDF and
TIFF come back as embedded `resource` blocks with a base64 blob, which fewer
clients preview. Anything over 4MB is skipped with a note pointing at the other
two options.

Base64 costs about 33% on top of the file, and the payload lands in the agent's
context, so keep inline delivery for pages an agent needs to read:

| Settings | File size | Inline |
| --- | --- | --- |
| 75 dpi gray jpeg | ~10KB | yes |
| 150 dpi gray jpeg | ~38KB | yes |
| 300 dpi color pdf | ~520KB | yes |
| 300 dpi color png | ~13MB | over the limit |

**2. MCP resources.** Every file in the scan directory is exposed as
`scan://<filename>`. `resources/list` enumerates them with sizes and
timestamps, `resources/read` returns one as a base64 blob, and the `list_scans`
tool gives the same listing for clients that don't browse resources. This lets
an agent scan now and fetch bytes later, or pull an older scan it never asked
for.

**3. HTTP download.** `GET /files/<filename>` serves the file with its real
content type, streamed rather than base64'd, so size isn't a concern. It takes
the same bearer token, or `?token=<MCP_TOKEN>` for a browser or curl:

```bash
curl -O -H "Authorization: Bearer $MCP_TOKEN" http://pi.local:3000/files/scan-20260920-143000.pdf
```

`scan_document` and `list_scans` include a `url` for each file, built from the
request's `Host` header. Behind a proxy or tunnel, set `PUBLIC_BASE_URL` so the
URLs point at the public address instead.

Filenames are restricted to plain names in the scan directory; paths and
traversal are rejected.

## REST API

The same server exposes a plain HTTP API under `/api`, for things that don't
speak MCP — shell scripts, Home Assistant, an iOS Shortcut, a button on a wall.
It shares `MCP_TOKEN`: send `Authorization: Bearer <token>`, or `?token=<token>`
for browsers.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/scanners` | List scanners |
| `GET` | `/api/scans` | List scanned files, newest first |
| `POST` | `/api/scans` | Start a scan |
| `GET` | `/api/scans/<name>` | Download one (`?download=true` to force save) |
| `DELETE` | `/api/scans/<name>` | Delete one |
| `GET` | `/api/jobs` | List recent scan jobs |
| `GET` | `/api/jobs/<id>` | One job's status, progress and result |
| `GET` | `/api/printers` | Printer status, ink levels, queue |
| `POST` | `/api/print` | Print a scan or base64 content |
| `GET` | `/api/print/jobs` | The print queue |
| `DELETE` | `/api/print/jobs/<id>` | Cancel a print job |
| `POST` | `/api/print/copies` | Scan and print in one step |
| `GET` | `/healthz` | Health probe, no auth |

`POST /api/scans` takes the same options as the MCP tool, all optional:

```bash
curl -X POST http://pi.local:3000/api/scans \
  -H "Authorization: Bearer $MCP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"resolution":300,"mode":"Color","format":"pdf","name":"receipt"}'
```

It holds the connection until the scan finishes (about 45 seconds at 300 dpi
color) and returns `201` with the result and a `Location` header pointing at
the file.

For clients that can't wait — proxies with short timeouts, Shortcuts, a
doorbell-style trigger — add `?wait=false`. That returns `202` immediately with
a job id, and `GET /api/jobs/<id>` reports `running` with a progress percentage,
then `done` with the same result, or `error` with the message:

```bash
job=$(curl -s -X POST "http://pi.local:3000/api/scans?wait=false" \
  -H "Authorization: Bearer $MCP_TOKEN" -d '{"resolution":150}' | jq -r .id)
curl -s "http://pi.local:3000/api/jobs/$job" -H "Authorization: Bearer $MCP_TOKEN" | jq .progress
```

Jobs live in memory: the last 50, for an hour, and they're gone on restart. The
scans themselves stay on disk regardless.

Errors come back as JSON (`{"error": "..."}`) with a real status code: `400` for
a bad filename, `404` missing, `405` wrong method, `422` for a body that fails
validation (with the offending fields), `500` if the scanner itself failed.

`GET /files/<name>` still works as an alias for `GET /api/scans/<name>`.

## Printing

The MX490 advertises `image/jpeg`, `image/urf` and `image/pwg-raster` over IPP
— **no PDF**. Your Mac hides this by rasterizing in CUPS before sending. So the
container runs its own `cupsd`: the entrypoint starts it, adds the printer as an
IPP Everywhere queue from `PRINTER_HOST`, and `lp` handles conversion.

```bash
curl -X POST http://pi.local:3000/api/print \
  -H "Authorization: Bearer $MCP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"scan":"receipt.pdf","copies":2,"color":"monochrome","quality":"draft"}'
```

Options on `print_file` / `POST /api/print`: `copies` (1–20), `color`
(`color`/`monochrome`), `quality` (`draft`/`normal`/`high`), `media` (e.g.
`na_letter_8.5x11in`), `pages` (`1-3,7`), `fit_to_page`. Print either a `scan`
already on the server or base64 `content` with a `filename`. The MX490 is
one-sided only, so there's no duplex option.

`copy_document` (or `POST /api/print/copies`) scans and prints in one step. ADF
copies print one job per page.

`printer_status` reads ink levels straight off the printer over IPP, so it
reports what the panel does:

```json
{ "printer": "MX490", "state": "idle", "model": "Canon MX490 series",
  "ink": [{ "name": "Color", "level": 40 }, { "name": "Black", "level": 10 }],
  "queued": 0 }
```

Printing is why the image is larger (CUPS, filters and Ghostscript) and why the
container runs as root — `cupsd` requires it. Set `PRINTING=off` to skip the
daemon and run scan-only; the print tools then report that no queue exists.
`PRINTER_HOST` (or a full `PRINTER_URI`) and `PRINTER_QUEUE` configure the
queue.

## Notes

- **macOS Local Network.** On a Mac, whichever app launches the server needs
  Local Network permission, or scanimage's UDP is blocked and the process dies
  with SIGPIPE. Terminal.app works; iTerm may need a restart. Linux has no
  such check, which is one reason the Pi is a better host.
- **Speed.** 300 dpi color flatbed takes about 45 seconds over Wi-Fi, 75 dpi
  about 15.
- **ADF.** `source: "ADF"` scans the whole feeder and returns one file per
  page. Untested.
- **Print tools use paper and ink.** They're marked destructive in the MCP
  annotations, so clients that ask before destructive calls will prompt.
