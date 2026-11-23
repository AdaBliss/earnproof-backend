#!/usr/bin/env python3
"""Generate cross-runtime golden vectors for request body hashing (v1).

This is an independent implementation of the version-1 scheme in
``src/common/crypto/request-body-hash.ts``, written against Python's JSON
serializer rather than Node's:

1. Recursively strip fields whose key names a secret (same rules as
   ``isSensitivePayloadKey`` in the TypeScript module).
2. Canonicalize: sort object keys, keep array order, no whitespace,
   ``ensure_ascii=False`` so non-ASCII text stays raw UTF-8 exactly as
   ``JSON.stringify`` emits it.
3. Hash: lowercase hex SHA-256 of the canonical UTF-8 bytes.

Run from the repo root::

    python3 scripts/generate-request-body-hash-vectors.py

It rewrites ``src/common/crypto/testdata/request-body-hash-vectors.v1.json``.
``request-body-hash.spec.ts`` asserts Node reproduces every vector exactly —
that is the cross-runtime test for canonicalization. Keep the vectors free
of values whose JSON spelling differs between runtimes (``-0``, integers
above 2**53, non-finite numbers); those are covered by Node-only tests.
"""

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/common/crypto/testdata/request-body-hash-vectors.v1.json"

SENSITIVE_PATTERNS = [
    re.compile(p)
    for p in (
        r"secret",
        r"password|passwd",
        r"privatekey",
        r"apikey",
        r"accesstoken",
        r"authtoken",
        r"bearer",
        r"credential",
        r"signingkey",
        r"encryptionkey",
        r"seedphrase",
        r"mnemonic",
    )
]


def is_sensitive_key(key: str) -> bool:
    normalized = key.lower().replace("_", "").replace("-", "")
    if normalized == "token" or normalized.endswith("token"):
        return True
    return any(p.search(normalized) for p in SENSITIVE_PATTERNS)


def redact(value, path, redacted):
    if isinstance(value, list):
        return [
            redact(item, f"{path}[{i}]" if path else f"[{i}]", redacted)
            for i, item in enumerate(value)
        ]
    if isinstance(value, dict):
        out = {}
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else key
            if is_sensitive_key(key):
                redacted.append(child_path)
                continue
            out[key] = redact(child, child_path, redacted)
        return out
    return value


def canonical(value) -> str:
    # sort_keys=True, separators without whitespace, ensure_ascii=False:
    # the same byte layout JSON.stringify produces for these values.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


VECTORS = [
    {"name": "empty-object", "payload": {}},
    {"name": "flat-key-order", "payload": {"b": 1, "a": "x"}},
    {
        "name": "nested-arrays-and-null",
        "payload": {"z": {"b": [3, 2, 1], "a": None}, "a": True},
    },
    {
        "name": "unicode",
        "payload": {"name": "café ☃ 🎉", "emoji": "🎉"},
    },
    {
        "name": "numbers",
        "payload": {
            "int": 42,
            "neg": -7,
            "float": 12.5,
            "big": 9007199254740991,
            "exp": 1e21,
        },
    },
    {
        "name": "array-order-preserved",
        "payload": {"items": [{"b": 2, "a": 1}, "x", None, False]},
    },
    {
        "name": "secret-keys-redacted",
        "payload": {
            "apiKey": "sk-live-123",
            "nested": {"password": "hunter2", "ok": 1},
            "token": "abc",
            "tokenId": "tok_123",
            "amount": "500.0000000",
        },
    },
    {
        "name": "escaping",
        "payload": {"a\"b": "line\nbreak\ttab", "slash": "a/b"},
    },
    {
        "name": "deep-nesting",
        "payload": {"l1": {"l2": {"l3": {"l4": {"l5": "deep"}}}}},
    },
    {
        "name": "empty-string-and-zero",
        "payload": {"s": "", "n": 0, "f": False, "arr": []},
    },
]


def main() -> None:
    vectors = []
    for vector in VECTORS:
        redacted_keys: list[str] = []
        redacted = redact(vector["payload"], "", redacted_keys)
        canonical_form = canonical(redacted)
        digest = hashlib.sha256(canonical_form.encode("utf-8")).hexdigest()
        vectors.append(
            {
                "name": vector["name"],
                "version": 1,
                "payload": vector["payload"],
                "canonical": canonical_form,
                "hash": digest,
                "redactedKeys": sorted(redacted_keys),
            }
        )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {"version": 1, "vectors": vectors}, indent=2, ensure_ascii=False
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(vectors)} vectors to {OUT}")


if __name__ == "__main__":
    main()
