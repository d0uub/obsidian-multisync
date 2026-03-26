/**
 * Provider-specific hash computation for local file content.
 * Each cloud provider uses a different hash algorithm:
 *  - OneDrive: quickXorHash (160-bit XOR-based, base64 encoded)
 *  - Dropbox:  content_hash (SHA-256 of 4MB-block SHA-256s, hex encoded)
 *  - GDrive:   md5Checksum (MD5, hex encoded)
 */

import { createHash } from "crypto";

// ─── QuickXorHash (OneDrive) ───────────────────────────────────────────────

const SHIFT = 11;
const WIDTH_IN_BITS = 160;
const BITS_IN_LAST_CELL = 32;
const DATA_LENGTH = Math.floor((WIDTH_IN_BITS - 1) / 64) + 1; // 3

/**
 * Microsoft QuickXorHash — ported from the official C# sample.
 * Returns base64-encoded hash string matching OneDrive's file.hashes.quickXorHash.
 */
export function quickXorHash(buf: ArrayBuffer): string {
  const array = new Uint8Array(buf);
  const data = new BigUint64Array(DATA_LENGTH);
  let shiftSoFar = 0;
  let lengthSoFar = 0;

  // Process in chunks to avoid massive loop overhead on large files
  const cbSize = array.length;
  let currentShift = shiftSoFar;
  let vectorArrayIndex = Math.floor(currentShift / 64);
  let vectorOffset = currentShift % 64;
  const iterations = Math.min(cbSize, WIDTH_IN_BITS);

  for (let i = 0; i < iterations; i++) {
    const isLastCell = vectorArrayIndex === DATA_LENGTH - 1;
    const bitsInVectorCell = isLastCell ? BITS_IN_LAST_CELL : 64;

    if (vectorOffset <= bitsInVectorCell - 8) {
      for (let j = i; j < cbSize; j += WIDTH_IN_BITS) {
        data[vectorArrayIndex] ^= BigInt(array[j]) << BigInt(vectorOffset);
      }
    } else {
      const index1 = vectorArrayIndex;
      const index2 = isLastCell ? 0 : vectorArrayIndex + 1;
      const low = bitsInVectorCell - vectorOffset;

      let xoredByte = 0;
      for (let j = i; j < cbSize; j += WIDTH_IN_BITS) {
        xoredByte ^= array[j];
      }
      data[index1] ^= BigInt(xoredByte) << BigInt(vectorOffset);
      data[index2] ^= BigInt(xoredByte) >> BigInt(low);
    }

    vectorOffset += SHIFT;
    while (vectorOffset >= bitsInVectorCell) {
      vectorArrayIndex = isLastCell ? 0 : vectorArrayIndex + 1;
      vectorOffset -= bitsInVectorCell;
    }
  }

  shiftSoFar =
    (shiftSoFar + SHIFT * (cbSize % WIDTH_IN_BITS)) % WIDTH_IN_BITS;
  lengthSoFar += cbSize;

  // Finalize: build 20-byte result
  const rgb = new Uint8Array(Math.floor((WIDTH_IN_BITS - 1) / 8) + 1); // 20 bytes

  // Copy BigUint64 cells to byte array (little-endian)
  for (let i = 0; i < DATA_LENGTH - 1; i++) {
    const v = data[i];
    for (let b = 0; b < 8; b++) {
      rgb[i * 8 + b] = Number((v >> BigInt(b * 8)) & 0xFFn);
    }
  }
  // Last cell (only 4 bytes for 32-bit)
  const lastIdx = DATA_LENGTH - 1;
  const lastVal = data[lastIdx];
  const lastBytes = rgb.length - lastIdx * 8;
  for (let b = 0; b < lastBytes; b++) {
    rgb[lastIdx * 8 + b] = Number((lastVal >> BigInt(b * 8)) & 0xFFn);
  }

  // XOR file length (as 8-byte little-endian) into last 8 bytes
  const len = BigInt(lengthSoFar);
  const lenOffset = WIDTH_IN_BITS / 8 - 8; // 20 - 8 = 12
  for (let b = 0; b < 8; b++) {
    rgb[lenOffset + b] ^= Number((len >> BigInt(b * 8)) & 0xFFn);
  }

  return uint8ToBase64(rgb);
}

// ─── Dropbox Content Hash ──────────────────────────────────────────────────

const BLOCK_SIZE = 4 * 1024 * 1024; // 4 MB

/**
 * Dropbox content_hash: SHA-256 of concatenated per-4MB-block SHA-256 hashes.
 * Returns lowercase hex string matching Dropbox's content_hash field.
 */
export async function dropboxContentHash(
  buf: ArrayBuffer
): Promise<string> {
  const data = new Uint8Array(buf);
  const blockHashes: Uint8Array[] = [];

  for (let offset = 0; offset < data.length; offset += BLOCK_SIZE) {
    const end = Math.min(offset + BLOCK_SIZE, data.length);
    const block = data.subarray(offset, end);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", block));
    blockHashes.push(hash);
  }

  // Handle empty file: hash empty string
  const concat = new Uint8Array(blockHashes.length * 32);
  for (let i = 0; i < blockHashes.length; i++) {
    concat.set(blockHashes[i], i * 32);
  }

  const finalHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", concat)
  );
  return uint8ToHex(finalHash);
}

// ─── MD5 (Google Drive) ───────────────────────────────────────────────────

/**
 * MD5 hash using Node.js crypto (available in Electron).
 * Returns lowercase hex string matching GDrive's md5Checksum field.
 */
export function md5Hash(buf: ArrayBuffer): string {
  return createHash("md5").update(Buffer.from(buf)).digest("hex");
}

// ─── Provider dispatch ─────────────────────────────────────────────────────

/**
 * Compute local file hash matching the algorithm used by the given provider.
 * Returns the hash string, or undefined if the provider type is unknown.
 */
export async function computeLocalHash(
  providerKind: string,
  content: ArrayBuffer
): Promise<string | undefined> {
  switch (providerKind) {
    case "onedrive":
      return quickXorHash(content);
    case "dropbox":
      return dropboxContentHash(content);
    case "gdrive":
      return md5Hash(content);
    default:
      return undefined;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function uint8ToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
