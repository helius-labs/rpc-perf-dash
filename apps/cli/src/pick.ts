/**
 * Interactive method picker — an arrow-key selector shown on a TTY so you can
 * choose methods without memorizing `--methods` flag syntax.
 *
 *   ←/→ or ↑/↓   move the cursor
 *   space        toggle the highlighted method
 *   a / n        select all / none
 *   enter        run — the toggled set, or just the highlighted one if none toggled
 *   q / esc      cancel (runs all methods)
 *   ctrl-c       abort
 *
 * Renders to stderr (stdout stays reserved for the table / --json). A fixed-
 * height scrolling window keeps the in-place redraw stable on any terminal size.
 * Non-TTY / no raw mode → returns `preselected` unchanged (callers gate on TTY).
 */

import { type Method } from "@rpcbench/shared";
import { VALID_METHODS } from "./config.js";

const WINDOW = 12; // visible rows

export async function pickMethods(preselected: Method[]): Promise<Method[]> {
  const all = VALID_METHODS;
  const stdin = process.stdin;
  const out = process.stderr;

  // No raw mode available (piped/non-TTY) → nothing to drive the UI; keep as-is.
  if (typeof stdin.setRawMode !== "function" || !stdin.isTTY) return preselected;

  const selected = new Set<Method>();
  let cursor = 0;
  let lastLines = 0;

  const cols = () => Math.max(20, (out.columns ?? 80) - 1);
  const clip = (s: string) => (s.length > cols() ? s.slice(0, cols() - 1) + "…" : s);

  const frame = (): string[] => {
    const lines: string[] = [];
    lines.push("Pick methods to benchmark:");
    lines.push("  ←/→ move · space toggle · a all · n none · enter run · q cancel");
    lines.push("");
    const start = Math.min(Math.max(0, cursor - Math.floor(WINDOW / 2)), Math.max(0, all.length - WINDOW));
    const end = Math.min(all.length, start + WINDOW);
    lines.push(start > 0 ? "    ⋯" : "");
    for (let i = start; i < end; i++) {
      const m = all[i]!;
      const arrow = i === cursor ? "❯" : " ";
      const box = selected.has(m) ? "◉" : "◯";
      lines.push(`  ${arrow} ${box} ${m}`);
    }
    lines.push(end < all.length ? "    ⋯" : "");
    lines.push("");
    const n = selected.size;
    const hint = n === 0 ? `enter runs: ${all[cursor]}` : `${n} selected`;
    lines.push(`  ${hint}`);
    return lines.map(clip);
  };

  const render = (): void => {
    const lines = frame();
    if (lastLines > 0) out.write(`\x1b[${lastLines}A`);
    for (const l of lines) out.write(`\x1b[2K${l}\n`);
    lastLines = lines.length;
  };

  return await new Promise<Method[]>((resolve) => {
    const cleanup = () => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode!(false);
      } catch {
        /* ignore */
      }
      stdin.pause();
      out.write("\x1b[?25h"); // show cursor
    };
    const finish = (result: Method[]) => {
      cleanup();
      out.write(`\nRunning ${result.length} method(s): ${result.join(", ")}\n`);
      resolve(result);
    };

    const move = (delta: number) => {
      cursor = (cursor + delta + all.length) % all.length;
      render();
    };

    const onData = (buf: Buffer | string) => {
      const s = buf.toString();
      if (s === "\x03") {
        // Ctrl-C
        cleanup();
        out.write("\n");
        process.exit(130);
      } else if (s === "\x1b[A" || s === "\x1b[D") {
        move(-1); // up / left
      } else if (s === "\x1b[B" || s === "\x1b[C") {
        move(1); // down / right
      } else if (s === " ") {
        const m = all[cursor]!;
        if (selected.has(m)) selected.delete(m);
        else selected.add(m);
        render();
      } else if (s === "a" || s === "A") {
        all.forEach((m) => selected.add(m));
        render();
      } else if (s === "n" || s === "N") {
        selected.clear();
        render();
      } else if (s === "\r" || s === "\n") {
        const result = selected.size > 0 ? all.filter((m) => selected.has(m)) : [all[cursor]!];
        finish(result);
      } else if (s === "q" || s === "Q" || s === "\x1b") {
        finish([...all]); // cancel → run all
      }
    };

    stdin.setRawMode!(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    out.write("\x1b[?25l"); // hide cursor
    stdin.on("data", onData);
    render();
  });
}
