import assert from "node:assert/strict";
import test from "node:test";
import { sha256Hex } from "../src/lib/sha256.js";

test("produces standard SHA-256 digests for UTF-8 text", () => {
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256Hex("Signal 🧭"),
    "cf0f889c60d348009d30668f2efc6e17fd6cbc202b2908b132e7dcf24943491f",
  );
});
