import { assert, describe, it } from "vitest";

import { isWindowsPlatform, randomUuid } from "./utils";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

describe("randomUuid", () => {
  it("returns a v4 uuid when crypto.randomUUID is unavailable", () => {
    const originalCrypto = globalThis.crypto;
    const stubCrypto = {
      getRandomValues(buffer: Uint8Array) {
        for (let index = 0; index < buffer.length; index += 1) {
          buffer[index] = index;
        }
        return buffer;
      },
    } as Crypto;

    Object.defineProperty(globalThis, "crypto", {
      value: stubCrypto,
      configurable: true,
    });

    try {
      assert.match(randomUuid(), UUID_V4_PATTERN);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: originalCrypto,
        configurable: true,
      });
    }
  });
});
