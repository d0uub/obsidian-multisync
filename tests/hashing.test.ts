import { describe, it, expect } from "vitest";
import { quickXorHash, dropboxContentHash, md5Hash, computeLocalHash } from "../src/utils/hashing";

describe("quickXorHash", () => {
  it("returns a base64 string for empty input", () => {
    const buf = new ArrayBuffer(0);
    const hash = quickXorHash(buf);
    // Empty file: only length (0) XOR'd in, result is 20 zero bytes → base64 "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    // Actually length=0 → all zeros → base64 of 20 zero bytes
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  it("returns consistent hashes for same input", () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const h1 = quickXorHash(data.buffer);
    const h2 = quickXorHash(data.buffer);
    expect(h1).toBe(h2);
  });

  it("returns different hashes for different input", () => {
    const a = new Uint8Array([1, 2, 3]).buffer;
    const b = new Uint8Array([4, 5, 6]).buffer;
    expect(quickXorHash(a)).not.toBe(quickXorHash(b));
  });

  it("produces a 20-byte hash encoded as base64 (28 chars)", () => {
    const data = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) data[i] = i % 256;
    const hash = quickXorHash(data.buffer);
    // 20 bytes → ceil(20/3)*4 = 28 base64 chars
    expect(hash.length).toBe(28);
  });
});

describe("dropboxContentHash", () => {
  it("returns a 64-char hex string for small input", async () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const hash = await dropboxContentHash(data.buffer);
    expect(hash.length).toBe(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns consistent hashes for same input", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const h1 = await dropboxContentHash(data);
    const h2 = await dropboxContentHash(data);
    expect(h1).toBe(h2);
  });

  it("handles empty input", async () => {
    const hash = await dropboxContentHash(new ArrayBuffer(0));
    // SHA-256 of empty concatenation = SHA-256 of empty string
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("md5Hash", () => {
  it("returns a 32-char hex string", () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const hash = md5Hash(data.buffer);
    expect(hash.length).toBe(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("computes correct MD5 for 'Hello'", () => {
    const encoder = new TextEncoder();
    const data = encoder.encode("Hello");
    const hash = md5Hash(data.buffer);
    // MD5("Hello") = 8b1a9953c4611296a827abf8c47804d7
    expect(hash).toBe("8b1a9953c4611296a827abf8c47804d7");
  });
});

describe("computeLocalHash", () => {
  it("dispatches to quickXorHash for onedrive", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const hash = await computeLocalHash("onedrive", data);
    expect(hash).toBe(quickXorHash(data));
  });

  it("dispatches to dropboxContentHash for dropbox", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const hash = await computeLocalHash("dropbox", data);
    expect(hash).toBe(await dropboxContentHash(data));
  });

  it("dispatches to md5Hash for gdrive", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const hash = await computeLocalHash("gdrive", data);
    expect(hash).toBe(md5Hash(data));
  });

  it("returns undefined for unknown provider", async () => {
    const hash = await computeLocalHash("unknown", new ArrayBuffer(0));
    expect(hash).toBeUndefined();
  });
});
