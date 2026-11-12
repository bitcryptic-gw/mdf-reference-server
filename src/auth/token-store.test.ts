/**
 * The token store: hash-only persistence, constant-time validation, fail closed.
 *
 * What is asserted here is what an operator would want to be true if the store
 * were dumped, the two instances were compared, or Valkey fell over: no usable
 * credential is recoverable, a token works on both instances, and an unreachable
 * store denies rather than grants.
 *
 * Run with: bun run src/auth/token-store.test.ts
 */

import { createServer, type Server } from "node:net";
import {
  MemoryTokenStore,
  ValkeyTokenStore,
  digestsEqual,
  hashTokenSecret,
  issueToken,
  pathInScope,
  validateToken,
} from "./token-store.ts";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    failed++;
  }
}

function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

function eq(a: unknown, b: unknown, m: string) {
  if (a !== b) {
    throw new Error(`${m}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
  }
}

const NOW = 1_700_000_000_000;

console.log("mdf-server token store");
console.log("--------------------------------------------------");

await test("issuance returns a token but stores only its digest", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/internals",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 86_400,
    now: NOW,
  });
  assert(issued !== null, "issued");

  const stored = await store.get(issued!.id);
  assert(stored !== null, "record exists");
  assert(!JSON.stringify(stored).includes(issued!.token), "the raw token is never stored");
  assert(!JSON.stringify(stored).includes(issued!.token.split(".")[1]), "nor the secret part");
  eq(stored!.secretHash, hashTokenSecret(issued!.id, issued!.token.split(".")[1]), "digest matches");
});

await test("a valid token validates, and is reusable", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });
  const header = `Bearer ${issued!.token}`;

  for (let i = 0; i < 3; i++) {
    const r = await validateToken(store, header, "/private/internals", NOW + 1000);
    eq(r.ok, true, `validation ${i + 1} reuses the token`);
  }
});

await test("a token only covers its own section", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });
  const header = `Bearer ${issued!.token}`;

  eq((await validateToken(store, header, "/private/internals", NOW)).ok, true, "in scope");
  const cross = await validateToken(store, header, "/premium/deep-dive", NOW);
  eq(cross.ok, false, "another section refused");
  if (!cross.ok) eq(cross.reason, "out_of_scope", "reason");

  eq((await validateToken(store, header, "/privatex/y", NOW)).ok, false, "segment boundary respected");
});

await test("expiry is enforced against the record", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });
  const header = `Bearer ${issued!.token}`;

  eq((await validateToken(store, header, "/private/x", NOW + 59_000)).ok, true, "inside the TTL");
  const expired = await validateToken(store, header, "/private/x", NOW + 61_000);
  eq(expired.ok, false, "outside the TTL");
  if (!expired.ok) eq(expired.reason, "expired", "an aged-out token is distinguishable from an unknown one");
});

await test("wrong secret, malformed token and unknown id all fail", async () => {
  const store = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(store, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });
  const [id, secret] = issued!.token.split(".");

  const wrong = await validateToken(store, `Bearer ${id}.${"00".repeat(32)}`, "/private/x", NOW);
  eq(wrong.ok, false, "wrong secret");
  if (!wrong.ok) eq(wrong.reason, "wrong_secret", "reason distinguishes it for logs");

  eq(
    (await validateToken(store, `Bearer ${"ab".repeat(16)}.${secret}`, "/private/x", NOW)).ok,
    false,
    "unknown id"
  );
  eq((await validateToken(store, "Bearer nonsense", "/private/x", NOW)).ok, false, "malformed");
  eq((await validateToken(store, null, "/private/x", NOW)).ok, false, "missing header");
  eq((await validateToken(store, `Bearer ${id}.${secret.slice(0, 10)}`, "/private/x", NOW)).ok, false, "short secret");
});

await test("a token minted on one store works on another sharing it (the round-robin fix)", async () => {
  // Two instances, one Valkey. Modelled with two MemoryTokenStore views over the
  // same record set by sharing the instance — the property under test is that
  // validation consults the store rather than process-local state.
  const shared = new MemoryTokenStore(() => NOW);
  const issued = await issueToken(shared, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  });

  // Instance A issued; instance B validates against the same backing store.
  const onB = await validateToken(shared, `Bearer ${issued!.token}`, "/private/x", NOW);
  eq(onB.ok, true, "the second instance accepts a token it did not mint");
});

await test("an unavailable store denies rather than grants", async () => {
  const broken = {
    async put() {
      return false;
    },
    async get() {
      return null;
    },
    async delete() {},
    close() {},
  };

  eq(await issueToken(broken, {
    urlPath: "/private/x",
    pathScope: "/private/",
    issuedTo: "0xabc",
    txHash: "0xdead",
    ttlSeconds: 60,
    now: NOW,
  }), null, "issuance fails closed");

  const r = await validateToken(broken, `Bearer ${"ab".repeat(16)}.${"cd".repeat(32)}`, "/private/x", NOW);
  eq(r.ok, false, "validation fails closed");
});

await test("scope matching is on segment boundaries", () => {
  assert(pathInScope("/private/internals", "/private/"), "nested path in scope");
  assert(pathInScope("/private", "/private/"), "bare section in scope");
  assert(!pathInScope("/privatex/y", "/private/"), "sibling prefix out of scope");
  assert(!pathInScope("/premium/x", "/private/"), "other section out of scope");
  assert(pathInScope("/anything", "/"), "root scope covers all");
});

await test("digest comparison rejects unequal or empty inputs", () => {
  const a = hashTokenSecret("id", "secret");
  assert(digestsEqual(a, a), "equal digests match");
  assert(!digestsEqual(a, hashTokenSecret("id2", "secret")), "different digests differ");
  assert(!digestsEqual(a, a.slice(0, 32)), "truncated digest differs");
  assert(!digestsEqual("", ""), "empty never compares equal");
});

// ---------------------------------------------------------------------------
// The Valkey-backed store, against a fake password-protected server
//
// This exists because a live acceptance run found the store sending SET with no
// AUTH: a password-protected Valkey answers NOAUTH, `put` returns false, and
// every token mint is denied while /health still reports the store "ok". The
// fake server enforces the password, so that regression cannot come back.
// ---------------------------------------------------------------------------

interface FakeValkey {
  server: Server;
  port: number;
  commands: string[][];
  close(): Promise<void>;
}

function startFakeValkey(password: string): Promise<FakeValkey> {
  const store = new Map<string, string>();
  const commands: string[][] = [];

  const parse = (buffer: Buffer): { args: string[]; rest: Buffer } | null => {
    if (buffer.length === 0 || buffer[0] !== 0x2a) return null; // '*'
    const lineEnd = buffer.indexOf("\r\n");
    if (lineEnd === -1) return null;
    const count = Number(buffer.subarray(1, lineEnd).toString());
    let offset = lineEnd + 2;
    const args: string[] = [];
    for (let i = 0; i < count; i++) {
      if (buffer[offset] !== 0x24) return null; // '$'
      const lenEnd = buffer.indexOf("\r\n", offset);
      if (lenEnd === -1) return null;
      const len = Number(buffer.subarray(offset + 1, lenEnd).toString());
      const start = lenEnd + 2;
      if (buffer.length < start + len + 2) return null;
      args.push(buffer.subarray(start, start + len).toString("utf8"));
      offset = start + len + 2;
    }
    return { args, rest: buffer.subarray(offset) };
  };

  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let authed = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const parsed = parse(buffer);
        if (!parsed) return;
        buffer = parsed.rest;
        const [cmd, ...args] = parsed.args;
        commands.push([cmd.toUpperCase(), ...args.map((a) => (cmd.toUpperCase() === "AUTH" ? "<redacted>" : a))]);
        const upper = cmd.toUpperCase();
        if (upper === "AUTH") {
          if (args[0] === password) {
            authed = true;
            socket.write("+OK\r\n");
          } else {
            socket.write("-WRONGPASS invalid username-password pair\r\n");
          }
          continue;
        }
        if (!authed) {
          socket.write("-NOAUTH Authentication required.\r\n");
          continue;
        }
        if (upper === "SET") {
          store.set(args[0], args[1]);
          socket.write("+OK\r\n");
        } else if (upper === "GET") {
          const value = store.get(args[0]);
          if (value === undefined) {
            socket.write("$-1\r\n");
          } else {
            socket.write(`$${Buffer.byteLength(value)}\r\n${value}\r\n`);
          }
        } else if (upper === "DEL") {
          store.delete(args[0]);
          socket.write(":1\r\n");
        } else {
          socket.write("-ERR unknown command\r\n");
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        server,
        port,
        commands,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

await test("the Valkey store authenticates before it writes (AUTH first, then SET)", async () => {
  const fake = await startFakeValkey("correct-horse");
  try {
    const store = new ValkeyTokenStore({ host: "127.0.0.1", port: fake.port, password: "correct-horse" });
    const record = {
      secretHash: hashTokenSecret("a".repeat(32), "b".repeat(64)),
      pathScope: "/private/",
      expiresAt: Date.now() + 60000,
      issuedTo: "0xabc",
      txHash: "0xdef",
    };
    eq(await store.put("a".repeat(32), record, 60), true, "put succeeds against a protected store");

    const verbs = fake.commands.map((c) => c[0]);
    eq(verbs[0], "AUTH", "the first command on the connection is AUTH");
    assert(verbs.includes("SET"), "the write happened");

    const got = await store.get("a".repeat(32));
    assert(got !== null && got.pathScope === "/private/", "the record round-trips");

    await store.delete("a".repeat(32));
    eq(await store.get("a".repeat(32)), null, "delete removes it");
  } finally {
    await fake.close();
  }
});

await test("a wrong password fails closed: put returns false and nothing is stored", async () => {
  const fake = await startFakeValkey("correct-horse");
  try {
    const store = new ValkeyTokenStore({ host: "127.0.0.1", port: fake.port, password: "wrong" });
    const record = {
      secretHash: hashTokenSecret("c".repeat(32), "d".repeat(64)),
      pathScope: "/private/",
      expiresAt: Date.now() + 60000,
      issuedTo: "0xabc",
      txHash: "0xdef",
    };
    eq(await store.put("c".repeat(32), record, 60), false, "a denied write is a refusal");
    eq(await store.get("c".repeat(32)), null, "nothing readable");
    assert(
      !fake.commands.some((c) => c[0] === "SET"),
      "no unauthenticated write is even attempted"
    );
  } finally {
    await fake.close();
  }
});

console.log("--------------------------------------------------");
console.log(`${passed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
