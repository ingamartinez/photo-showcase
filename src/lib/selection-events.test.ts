import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — same
// stub every other server-only module's own suite uses.
vi.mock("server-only", () => ({}));

type OnNotify = (payload: string) => void;
type OnListen = () => void;

/** A minimal double for `src/lib/db`'s `pubsub.listen`/`pubsub.notify` — NOT
 * a real Postgres connection (this suite proves the FAN-OUT and RECONNECT
 * logic this module owns, not postgres.js's own `LISTEN`/`NOTIFY` wire
 * protocol, which `scripts/verify-selection-listen-notify.ts` proves
 * separately against a real database). Records every `listen()` call so a
 * test can assert `pubsub.listen` was called exactly once regardless of how
 * many galleries subscribe (task #114's "one LISTEN connection per app
 * instance, not per viewer" claim), and exposes the registered
 * `onnotify`/`onlisten` callbacks so a test can simulate a NOTIFY or a
 * reconnect by calling them directly. */
function fakePubsub() {
  const listenCalls: { onnotify: OnNotify; onlisten: OnListen }[] = [];
  const notifyCalls: { channel: string; payload: string }[] = [];

  return {
    listenCalls,
    notifyCalls,
    listen: vi.fn(async (_channel: string, onnotify: OnNotify, onlisten?: OnListen) => {
      listenCalls.push({ onnotify, onlisten: onlisten ?? (() => {}) });
      onlisten?.();
      return { state: "listening", unlisten: async () => {} };
    }),
    notify: vi.fn(async (channel: string, payload: string) => {
      notifyCalls.push({ channel, payload });
      return [];
    }),
  };
}

let pubsub: ReturnType<typeof fakePubsub>;
vi.mock("@/lib/db", () => ({
  get pubsub() {
    return pubsub;
  },
}));

beforeEach(() => {
  pubsub = fakePubsub();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const GALLERY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GALLERY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("selection-events — the LISTEN/NOTIFY pub-sub", () => {
  it("calls pubsub.listen exactly ONCE no matter how many galleries subscribe", async () => {
    const { subscribeToSelectionChanges } = await import("./selection-events");

    await subscribeToSelectionChanges(GALLERY_A, () => {});
    await subscribeToSelectionChanges(GALLERY_B, () => {});
    await subscribeToSelectionChanges(GALLERY_A, () => {});

    // THE fan-out shape acceptance criterion: one LISTEN connection per app
    // instance, not per viewer and not per gallery.
    expect(pubsub.listen).toHaveBeenCalledTimes(1);
  });

  it("does not touch the database at module load — only on the first subscribe", async () => {
    await import("./selection-events");

    expect(pubsub.listen).not.toHaveBeenCalled();
  });

  it("routes a NOTIFY to only the listeners registered for that gallery's id", async () => {
    const { subscribeToSelectionChanges } = await import("./selection-events");
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    await subscribeToSelectionChanges(GALLERY_A, onChangeA);
    await subscribeToSelectionChanges(GALLERY_B, onChangeB);

    // Simulate Postgres delivering a NOTIFY whose payload is gallery A's id —
    // exactly what `notifySelectionChanged` sends (see the next describe
    // block), never re-derived here as a magic string.
    pubsub.listenCalls[0]!.onnotify(GALLERY_A);

    expect(onChangeA).toHaveBeenCalledTimes(1);
    expect(onChangeB).not.toHaveBeenCalled();
  });

  it("fans one NOTIFY out to every listener subscribed to the same gallery", async () => {
    const { subscribeToSelectionChanges } = await import("./selection-events");
    const first = vi.fn();
    const second = vi.fn();
    await subscribeToSelectionChanges(GALLERY_A, first);
    await subscribeToSelectionChanges(GALLERY_A, second);

    pubsub.listenCalls[0]!.onnotify(GALLERY_A);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("stops calling a listener once its own unsubscribe runs", async () => {
    const { subscribeToSelectionChanges } = await import("./selection-events");
    const onChange = vi.fn();
    const unsubscribe = await subscribeToSelectionChanges(GALLERY_A, onChange);

    unsubscribe();
    pubsub.listenCalls[0]!.onnotify(GALLERY_A);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("removing the last listener for a gallery does not affect a DIFFERENT gallery's own listeners", async () => {
    const { subscribeToSelectionChanges } = await import("./selection-events");
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    const unsubscribeA = await subscribeToSelectionChanges(GALLERY_A, onChangeA);
    await subscribeToSelectionChanges(GALLERY_B, onChangeB);

    unsubscribeA();
    pubsub.listenCalls[0]!.onnotify(GALLERY_B);

    expect(onChangeB).toHaveBeenCalledTimes(1);
  });

  // Task #114's own trap #2, second case: THIS process's own LISTEN
  // connection dropping and reconnecting (a network blip, or Postgres
  // itself restarting) loses any NOTIFY fired in that gap for EVERY gallery
  // this process serves, not just one — postgres.js's own `onlisten`
  // callback (verified against its source in src/lib/db/index.ts's own
  // comment, and empirically by scripts/verify-selection-listen-notify.ts)
  // fires again on every automatic resubscribe, which is what this module
  // treats as "broadcast a change to everything currently watched".
  it("broadcasts to EVERY currently-watched gallery when the listen connection (re)subscribes", async () => {
    const { subscribeToSelectionChanges } = await import("./selection-events");
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    await subscribeToSelectionChanges(GALLERY_A, onChangeA);
    await subscribeToSelectionChanges(GALLERY_B, onChangeB);
    onChangeA.mockClear();
    onChangeB.mockClear();

    // Simulate postgres.js re-invoking `onlisten` after the dedicated
    // connection reconnected — NOT a fresh `subscribeToSelectionChanges`
    // call, which is a different (browser-tab) case this module handles
    // identically but through a different path (the SSE route's own `ready`
    // message, proven in proof-grid.test.tsx).
    pubsub.listenCalls[0]!.onlisten();

    expect(onChangeA).toHaveBeenCalledTimes(1);
    expect(onChangeB).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the listen connection resubscribes with nobody currently watching", async () => {
    const { subscribeToSelectionChanges } = await import("./selection-events");
    const unsubscribe = await subscribeToSelectionChanges(GALLERY_A, () => {});
    unsubscribe();

    expect(() => pubsub.listenCalls[0]!.onlisten()).not.toThrow();
  });
});

describe("selection-events — notifySelectionChanged", () => {
  it("sends the bare gallery id as the NOTIFY payload, on the same channel subscribers listen on", async () => {
    const { subscribeToSelectionChanges, notifySelectionChanged } =
      await import("./selection-events");
    // Establishes the listen connection first, same as the app would (a
    // viewer opens the stream before anyone else's write ever fires) — not
    // load-bearing for this assertion, just realistic ordering.
    await subscribeToSelectionChanges(GALLERY_A, () => {});

    await notifySelectionChanged(GALLERY_A);

    expect(pubsub.notify).toHaveBeenCalledTimes(1);
    const [channel, payload] = pubsub.notify.mock.calls[0]!;
    expect(payload).toBe(GALLERY_A);
    // Whatever the channel name is, `pubsub.listen` and `pubsub.notify` used
    // the EXACT SAME one — this is what makes a notify actually reach a
    // subscriber. Asserted by comparing the two calls to each other, not by
    // re-typing the channel's own literal name here (which could silently
    // drift from the one this module actually uses).
    expect(pubsub.listen.mock.calls[0]![0]).toBe(channel);
  });

  it("never sends the selection snapshot on the wire — only the gallery id (trap #1)", async () => {
    const { notifySelectionChanged } = await import("./selection-events");

    await notifySelectionChanged(GALLERY_A);

    const [, payload] = pubsub.notify.mock.calls[0]!;
    // Well under Postgres's 8000-byte NOTIFY payload cap — a bare UUID, not
    // a JSON snapshot.
    expect(payload.length).toBeLessThan(64);
    expect(() => JSON.parse(payload)).toThrow();
  });
});
