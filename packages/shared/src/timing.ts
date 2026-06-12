/**
 * Latency timer semantics — frozen per `methodology_version`.
 *
 * Cold: TLS+TCP setup INCLUDED. Timer starts immediately before socket.connect()
 *       (with DNS pre-resolved at worker startup so DNS time is excluded).
 *       Timer ends at the first byte of the HTTP response body received by undici.
 *       JSON parsing is excluded.
 *
 * Warm: TLS+TCP setup EXCLUDED — connection was paid prior. Per-provider serialized
 *       HTTP/2 pool (only one in-flight request at a time per provider per worker)
 *       to eliminate head-of-line blocking effects. Timer starts at socket.write()
 *       of the request body, ends at first byte of HTTP response body.
 *
 * Both definitions are immutable per methodology_version. Bumping the version
 * forks rollups so historical comparisons stay coherent.
 */

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

/**
 * Methodology version. Bumped to 2 on 2026-05-27 when the neutral rotating
 * quorum was replaced with majority consensus across the benchmarked panel
 * plus an independent auditor cross-check. Forks rollup + leaderboard
 * tables so historical (v=1) leaderboards stay coherent — no re-scoring.
 */
export const METHODOLOGY_VERSION = 2 as const;

export interface TimedResponse {
  latency_ms: number;
  http_status: number;
  body: string;
  /** First-byte timestamp (ms) for diagnostics. */
  first_byte_at: number;
}

export interface ColdRequestOptions {
  url: URL;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Pre-resolved IP. The caller is responsible for DNS. */
  resolvedIp: string;
}

/**
 * Issue a single HTTP/1.1 POST over a freshly-opened TCP+TLS socket.
 *
 * We use a hand-rolled minimal HTTP/1.1 request rather than undici because we
 * need precise control over when the timer starts (immediately before
 * `socket.connect()`) and ends (first byte of response body received).
 * `undici.request` is fine for warm pools; for cold we want zero ambiguity.
 *
 * Returns latency_ms = (first response-body byte) - (socket.connect() call).
 */
export async function timedColdPost(opts: ColdRequestOptions): Promise<TimedResponse> {
  const { url, body, headers, timeoutMs, resolvedIp } = opts;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const host = url.hostname;
  const path = url.pathname + url.search;

  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let firstByteTs: number | null = null;
    const receivedChunks: Buffer[] = [];
    let timeoutHandle: NodeJS.Timeout | null = null;

    const onFinish = (status: number, responseBody: string) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (firstByteTs === null) {
        reject(new Error("timing: no response received"));
        return;
      }
      resolve({
        latency_ms: firstByteTs - t0,
        http_status: status,
        body: responseBody,
        first_byte_at: firstByteTs,
      });
    };

    const onError = (err: Error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    };

    timeoutHandle = setTimeout(() => onError(new Error("timeout")), timeoutMs);

    const useTls = url.protocol === "https:";
    const socket: Socket | TLSSocket = useTls
      ? tlsConnect({ host: resolvedIp, port, servername: host })
      : netConnect({ host: resolvedIp, port });

    const fullBody = body;
    const reqLines = [
      `POST ${path} HTTP/1.1`,
      `Host: ${host}`,
      `Content-Type: application/json`,
      `Content-Length: ${Buffer.byteLength(fullBody)}`,
      `Connection: close`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "",
      fullBody,
    ];
    const req = reqLines.join("\r\n");

    socket.on(useTls ? "secureConnect" : "connect", () => {
      socket.write(req);
    });

    socket.on("data", (chunk) => {
      if (firstByteTs === null) firstByteTs = performance.now();
      receivedChunks.push(chunk);
    });

    socket.on("end", () => {
      try {
        const { status, body: responseBody } = parseHttpResponse(Buffer.concat(receivedChunks));
        onFinish(status, responseBody);
      } catch (err) {
        onError(err as Error);
      }
    });

    socket.on("error", onError);
  });
}

/**
 * Parse a complete HTTP/1.1 response from raw bytes. Handles:
 *   - Status line ('HTTP/1.1 200 OK')
 *   - Headers (case-insensitive lookup)
 *   - Transfer-Encoding: chunked  → strips chunk-size lines, concatenates payload
 *   - Content-Length              → uses bytes 0..N
 *   - No length info              → returns everything after the header block
 *
 * IMPORTANT: this operates on `Buffer` (bytes), not a JS string. The chunk-size
 * field in HTTP/1.1 is a byte count, not a character count — operating on a
 * UTF-8-decoded string desyncs the offsets the moment the body contains any
 * non-ASCII byte (or a chunk arrives split mid-multibyte through socket.data).
 * This caused multi-MB getBlock responses to silently corrupt and look like
 * "incorrect" data mismatches.
 */
const CRLF = Buffer.from("\r\n");
const CRLF2 = Buffer.from("\r\n\r\n");

function parseHttpResponse(raw: Buffer): { status: number; body: string } {
  const headerEnd = raw.indexOf(CRLF2);
  if (headerEnd === -1) throw new Error("malformed response: no header terminator");
  const head = raw.subarray(0, headerEnd).toString("utf8"); // headers are ASCII
  const rest = raw.subarray(headerEnd + 4);

  const lines = head.split("\r\n");
  const statusLine = lines[0] ?? "";
  const statusMatch = statusLine.match(/^HTTP\/1\.\d (\d{3})/);
  const status = statusMatch?.[1] ? Number.parseInt(statusMatch[1], 10) : 0;

  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }

  const transferEncoding = headers.get("transfer-encoding")?.toLowerCase();
  if (transferEncoding && transferEncoding.includes("chunked")) {
    return { status, body: dechunk(rest).toString("utf8") };
  }

  const contentLength = headers.get("content-length");
  if (contentLength) {
    const n = Number.parseInt(contentLength, 10);
    if (Number.isFinite(n)) return { status, body: rest.subarray(0, n).toString("utf8") };
  }

  // Fallback: assume identity encoding, return everything.
  return { status, body: rest.toString("utf8") };
}

/**
 * Decode HTTP/1.1 chunked transfer encoding on raw bytes.
 *   <hex-size>\r\n<payload>\r\n<hex-size>\r\n<payload>\r\n0\r\n\r\n
 * Trailing chunk extensions (after `;`) are ignored.
 */
function dechunk(input: Buffer): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos < input.length) {
    const lineEnd = input.indexOf(CRLF, pos);
    if (lineEnd === -1) break;
    const sizeLine = input.subarray(pos, lineEnd).toString("ascii");
    const semi = sizeLine.indexOf(";");
    const sizeHex = (semi === -1 ? sizeLine : sizeLine.slice(0, semi)).trim();
    const size = Number.parseInt(sizeHex, 16);
    if (!Number.isFinite(size) || size < 0) break;
    pos = lineEnd + 2;
    if (size === 0) break;
    parts.push(input.subarray(pos, pos + size));
    pos += size + 2; // chunk + trailing CRLF
  }
  return Buffer.concat(parts);
}
