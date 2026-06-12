"use client";

/**
 * Render a challenge's target identifier (block / signature / address) with:
 *   - a click-through link to orbmarkets.io
 *   - a copy-to-clipboard button next to it
 *
 * URL patterns:
 *   - address   → https://orbmarkets.io/address/<addr>/history
 *   - signature → https://orbmarkets.io/tx/<sig>
 *   - block     → https://orbmarkets.io/block/<slot>/transactions
 *
 * Note: 'block' here is the slot number passed to getBlock. In Solana,
 * some slots are skipped (no block produced), but the canonical URL
 * across explorers — orbmarkets included — uses the slot number as the
 * block identifier in the path.
 */

import { useState } from "react";

type Target =
  | { kind: "block"; value: string; raw: string }
  | { kind: "sig"; value: string; raw: string }
  | { kind: "addr"; value: string; raw: string }
  // Non-linkable truncated identifier (blockhash, base64 tx) — shown as text.
  | { kind: "text"; value: string; raw: string }
  | { kind: "none" };

/** Slot-bearing methods whose params[0] is a slot number (linked as a block). */
const SLOT_FIRST_METHODS = new Set([
  "getBlock",
  "getBlockTime",
  "getBlockCommitment",
  "getBlocks", // params[0] = startSlot
  "getLeaderSchedule", // params[0] = slot
]);

/** Methods whose params[0] is a base58 address (linked to the address page). */
const ADDR_FIRST_METHODS = new Set([
  "getAccountInfo",
  "getProgramAccounts",
  "getTokenAccountsByOwner",
  "getBalance",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getTokenAccountBalance",
]);

function trunc(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

function parseTarget(method: string, params: unknown): Target {
  if (!Array.isArray(params) || params.length === 0) return { kind: "none" };
  const first = params[0];

  if (SLOT_FIRST_METHODS.has(method) && typeof first === "number") {
    return { kind: "block", value: first.toLocaleString(), raw: String(first) };
  }
  if (method === "getTransaction" && typeof first === "string") {
    return { kind: "sig", value: trunc(first), raw: first };
  }
  if (method === "getSignaturesForAddress") {
    const addr =
      typeof first === "string"
        ? first
        : typeof first === "object" && first && "pubkey" in first
          ? String((first as { pubkey: string }).pubkey)
          : null;
    if (addr) {
      return { kind: "addr", value: trunc(addr), raw: addr };
    }
  }
  // getInflationReward: params[0] is an array of vote-account addresses; show
  // the first as the representative target.
  if (method === "getInflationReward" && Array.isArray(first) && typeof first[0] === "string") {
    return { kind: "addr", value: trunc(first[0]), raw: first[0] };
  }
  // isBlockhashValid (blockhash) / simulateTransaction (base64 tx): a string
  // that isn't an on-chain address — show truncated, no explorer link.
  if (
    (method === "isBlockhashValid" || method === "simulateTransaction") &&
    typeof first === "string"
  ) {
    return { kind: "text", value: trunc(first), raw: first };
  }
  // getAccountInfo (pubkey), getProgramAccounts (programId),
  // getTokenAccountsByOwner (owner), getBalance (pubkey), getTokenSupply /
  // getTokenLargestAccounts (mint), getTokenAccountBalance (tokenAccount) all
  // carry a base58 address as params[0]. Methods carrying only { commitment }
  // (getSlot, getEpochInfo, getBlockHeight, getTransactionCount, getVoteAccounts,
  // getSlotLeader, …), a limit (getRecentPerformanceSamples), a config object
  // (simulateBundle, getBlockProduction), or no params (getGenesisHash,
  // getVersion, …) fall through to none.
  if (ADDR_FIRST_METHODS.has(method) && typeof first === "string") {
    return { kind: "addr", value: trunc(first), raw: first };
  }
  return { kind: "none" };
}

function urlFor(t: Target): string | null {
  if (t.kind === "addr") return `https://orbmarkets.io/address/${t.raw}/history`;
  if (t.kind === "sig") return `https://orbmarkets.io/tx/${t.raw}`;
  if (t.kind === "block") return `https://orbmarkets.io/block/${t.raw}/transactions`;
  return null;
}

export function ChallengeTarget({
  method,
  params,
}: {
  method: string;
  params: unknown;
}) {
  const t = parseTarget(method, params);
  const [copied, setCopied] = useState(false);

  if (t.kind === "none") {
    return <span style={{ color: "#666" }}>—</span>;
  }

  const onCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(t.raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can fail in some browsers / non-HTTPS contexts;
      // silent fallback — the visible string is still selectable.
    }
  };

  const url = urlFor(t);
  const valueStyle: React.CSSProperties = {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    color: "#bbb",
  };

  // stopPropagation on the wrapper so a click anywhere in the Target cell
  // (link, plain text, copy button, padding) doesn't bubble up to the row
  // navigation handler. The link itself still opens in a new tab via
  // target="_blank", the copy button does its own stopPropagation, and
  // clicks on text/padding become no-ops instead of accidentally triggering
  // row navigation.
  const stopRowClick = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      onClick={stopRowClick}
    >
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ ...valueStyle, color: "#7cc6ff", textDecoration: "none" }}
          title={`Open ${t.raw} on orbmarkets.io`}
        >
          {t.value}
        </a>
      ) : (
        <span style={valueStyle} title={t.raw}>
          {t.value}
        </span>
      )}
      <button
        type="button"
        onClick={onCopy}
        title={copied ? "Copied" : `Copy ${t.raw}`}
        aria-label={copied ? "Copied" : "Copy"}
        style={{
          all: "unset",
          cursor: "pointer",
          width: 18,
          height: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 3,
          background: copied ? "#0e2a18" : "transparent",
          color: copied ? "#7be0a4" : "#666",
          fontSize: 11,
          transition: "background 120ms, color 120ms",
        }}
      >
        {copied ? (
          // checkmark
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          // copy icon (two overlapping rectangles)
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="4" y="4" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M3 11V4a1.5 1.5 0 0 1 1.5-1.5H11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        )}
      </button>
    </span>
  );
}
