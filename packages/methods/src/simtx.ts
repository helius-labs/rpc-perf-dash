/**
 * Minimal Solana transaction builder for the simulation methods
 * (simulateTransaction, simulateBundle). The repo has NO Solana SDK, so we
 * hand-roll the wire format: a single Memo-program instruction with a zero
 * signature (callers pass `sigVerify:false`) and a real recent blockhash
 * (callers also pass `replaceRecentBlockhash:true`, so the blockhash value is
 * not load-bearing, but a real one keeps simulators that ignore the flag
 * happy). Memo compute units are deterministic and `err` is null, so the
 * resulting `{ err, unitsConsumed }` projection is byte-equal across providers.
 *
 * Just enough base58 decode + shortvec (compact-u16) encode to assemble the
 * bytes; not a general-purpose codec.
 */

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 string to bytes (big-endian). Throws on a bad character. */
export function base58Decode(s: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of s) {
    const val = B58_ALPHABET.indexOf(ch);
    if (val < 0) throw new Error(`invalid base58 char: ${ch}`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }
  // Preserve leading-zero bytes (encoded as '1').
  for (const ch of s) {
    if (ch === "1") bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}

/** shortvec (compact-u16) length prefix. */
function encodeLength(len: number): number[] {
  const out: number[] = [];
  let rem = len;
  for (;;) {
    const elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(elem);
      break;
    }
    out.push(elem | 0x80);
  }
  return out;
}

/** Memo program v2. */
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Assemble the raw legacy MESSAGE bytes (fee payer + Memo program, one Memo
 * instruction with no account metas) — i.e. everything a transaction wraps,
 * without the signature-count prefix or signatures. Shared by
 * `buildMemoTransactionBase64` (simulateTransaction / simulateBundle, which
 * need the full signed-tx wire form) and `buildMemoMessageBase64`
 * (getFeeForMessage, which takes a bare base64 message). `feePayer` should be a
 * funded account (a transaction signer from a recent block).
 */
export function buildMemoMessage(
  feePayer: string,
  recentBlockhash: string,
  memo: string,
): number[] {
  const fp = base58Decode(feePayer);
  const memoProg = base58Decode(MEMO_PROGRAM_ID);
  const bh = base58Decode(recentBlockhash);
  if (fp.length !== 32 || memoProg.length !== 32 || bh.length !== 32) {
    throw new Error("simtx: expected 32-byte pubkeys/blockhash");
  }
  const memoBytes = Array.from(Buffer.from(memo, "utf8"));

  const message: number[] = [];
  // header: 1 required sig, 0 readonly-signed, 1 readonly-unsigned (Memo program)
  message.push(1, 0, 1);
  // account keys: [feePayer, Memo program]
  message.push(...encodeLength(2), ...fp, ...memoProg);
  // recent blockhash
  message.push(...bh);
  // instructions: 1
  message.push(...encodeLength(1));
  // instruction: programIdIndex=1 (Memo), 0 account metas, memo data
  message.push(1);
  message.push(...encodeLength(0));
  message.push(...encodeLength(memoBytes.length), ...memoBytes);

  return message;
}

/**
 * Build a base64-encoded legacy transaction: a Memo message (see
 * `buildMemoMessage`) prefixed with a single zero 64-byte signature. Callers
 * pass `sigVerify:false`, so the zero signature is accepted.
 */
export function buildMemoTransactionBase64(
  feePayer: string,
  recentBlockhash: string,
  memo: string,
): string {
  const message = buildMemoMessage(feePayer, recentBlockhash, memo);

  const tx: number[] = [];
  tx.push(...encodeLength(1)); // 1 signature
  tx.push(...new Array(64).fill(0)); // zero signature (sigVerify:false)
  tx.push(...message);

  return Buffer.from(tx).toString("base64");
}

/**
 * Build a base64-encoded legacy MESSAGE (no signatures) for getFeeForMessage,
 * which fees a serialized message rather than a full transaction.
 */
export function buildMemoMessageBase64(
  feePayer: string,
  recentBlockhash: string,
  memo: string,
): string {
  return Buffer.from(buildMemoMessage(feePayer, recentBlockhash, memo)).toString("base64");
}
