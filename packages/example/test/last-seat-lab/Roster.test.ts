/**
 * "Last seat" acceptance test.
 *
 * The beat: a room holds 子 (score 5, left seat) and 丑 (score 9, right seat).
 * One beat clears both and seats 寅 (score 13). At the end of that beat both
 * screens — the main client and the spectator (StateView) client — show one
 * line: `寅 13`. Nothing else.
 *
 * The roster is a `MapSchema`, so the wire sizes are deterministic and part of
 * the contract:
 *   - clear + seat in one patch  → one patch body of 14 bytes
 *   - clear then seat            → a 3-byte body, then a 13-byte body
 * A lone 3-byte body (clear without the seat) is explicitly NOT accepted.
 *
 * These assertions use the room + serializer directly (the same fake-client
 * harness as `bundles/colyseus/test/Room.test.ts`) rather than sockets, so the
 * patch framing and body sizes are exact.
 */
import assert from "node:assert";
import { describe, it } from "node:test";

import { ClientState, type Client } from "@colyseus/core";
import { Decoder, StateView } from "@colyseus/schema";

import {
  CHOU,
  NEWCOMER_SCORE,
  Player,
  RosterRoom,
  RosterState,
  SEED,
  YIN,
  ZI,
} from "./Roster.ts";

type Roster = Array<[string, number]>;

/** A client that records every frame the room sends and decodes them in order. */
class Screen {
  readonly client: Client & { dec: Decoder<RosterState>; frames: Uint8Array[] };
  readonly view?: StateView;

  constructor(withView: boolean) {
    const frames: Uint8Array[] = [];
    const dec = new Decoder(new RosterState());

    this.view = withView ? new StateView() : undefined;
    this.client = {
      sessionId: Math.random().toString(36).slice(2),
      state: ClientState.JOINED,
      view: this.view,
      frames,
      dec,
      raw: (data: Uint8Array) => frames.push(Uint8Array.from(data)),
      // No datagram channel: this lab's state declares no @unreliable field.
      rawUnreliable: undefined,
      send: () => { },
      enqueueRaw: () => { },
      cork: () => { },
      uncork: () => { },
    } as any;
  }

  /** Bytes of every body received since the last call (protocol byte stripped). */
  takeBodies(): number[] {
    const bodies = this.client.frames.map((frame) => frame.byteLength - 1);
    for (const frame of this.client.frames) { this.client.dec.decode(frame.subarray(1)); }
    this.client.frames.length = 0;
    return bodies;
  }

  /** The one-line roster this screen is showing right now. */
  roster(): Roster {
    return [...this.client.dec.state.roster].map(([name, player]) => [name, player.score]);
  }
}

/** Hand the screen its full state (the join snapshot), then join the room. */
function attach(room: RosterRoom, screen: Screen) {
  const full = Uint8Array.from(room['_serializer'].getFullState(screen.client));
  screen.client.dec.decode(full.subarray(1));
  room.clients.push(screen.client);
  // settle the initial ADD diff, exactly as the first patch after a join would
  room.broadcastPatch();
  screen.takeBodies();
}

/**
 * A room already showing 子 5 (left) and 丑 9 (right) to both screens, with the
 * spectator's view holding both occupants — the "from now" starting point.
 */
function roomShowingBothOccupants() {
  const room = new RosterRoom();
  room['__init']();
  room.onCreate();

  const main = new Screen(false);
  const spectator = new Screen(true);

  // Seed before the join snapshots so both screens begin on the two occupants.
  room.seed();
  if (spectator.view) {
    // `get()` is typed optional; both keys were just seeded above.
    spectator.view.add(room.state.roster.get(ZI)!);
    spectator.view.add(room.state.roster.get(CHOU)!);
  }

  for (const screen of [main, spectator]) { attach(room, screen); }

  // Precondition for every test below: both screens start on the two occupants.
  assert.deepStrictEqual(main.roster(), SEED);
  assert.deepStrictEqual(spectator.roster(), SEED);

  return { room, main, spectator };
}

const THE_ANSWER: Roster = [[YIN, NEWCOMER_SCORE]];

/** Both screens and the server must show exactly the one-line roster. */
function assertFinalState(room: RosterRoom, main: Screen, spectator: Screen) {
  assert.deepStrictEqual([...room.state.roster].map(([name, p]) => [name, p.score]), THE_ANSWER, "server roster");
  assert.deepStrictEqual(main.roster(), THE_ANSWER, "main screen");
  assert.deepStrictEqual(spectator.roster(), THE_ANSWER, "spectator screen");

  // No old occupant, and no old score re-attributed to the newcomer.
  for (const screen of [main, spectator]) {
    assert.ok(!screen.client.dec.state.roster.has(ZI), "子 must be gone");
    assert.ok(!screen.client.dec.state.roster.has(CHOU), "丑 must be gone");
    assert.strictEqual(screen.client.dec.state.roster.get(YIN)?.score, NEWCOMER_SCORE);
  }
}

describe("last seat: clear both, seat 寅, end with only him", () => {

  it("atomic: one 14-byte patch clears 子 and 丑 and seats 寅 on both screens", () => {
    const { room, main, spectator } = roomShowingBothOccupants();

    room.beat("atomic");

    // One patch on the wire, and it is exactly 14 bytes.
    assert.deepStrictEqual(main.takeBodies(), [14], "main receives one 14-byte body");
    assert.deepStrictEqual(spectator.takeBodies(), [14], "spectator receives one 14-byte body");

    assertFinalState(room, main, spectator);
  });

  it("two-step: a 3-byte clear patch then a 13-byte seat patch, ending the same way", () => {
    const { room, main, spectator } = roomShowingBothOccupants();

    room.beat("two-step");

    // Clear-only body (3 bytes) followed by the seat body (13 bytes).
    assert.deepStrictEqual(main.takeBodies(), [3, 13], "main receives 3 then 13");
    assert.deepStrictEqual(spectator.takeBodies(), [3, 13], "spectator receives 3 then 13");

    assertFinalState(room, main, spectator);
  });

  it("a lone 3-byte clear is rejected: the room would be empty", () => {
    const { room, main, spectator } = roomShowingBothOccupants();

    // Perform only the clear half of the two-step path.
    room.state.roster.clear();
    room.broadcastPatch();

    assert.deepStrictEqual(main.takeBodies(), [3]);
    assert.deepStrictEqual(main.roster(), [], "empty room is rejected");
    assert.deepStrictEqual(spectator.takeBodies(), [3]);
    assert.deepStrictEqual(spectator.roster(), [], "empty room is rejected");
  });

  it("ordering trap: seat first then clear leaves an empty room (rejected)", () => {
    const { room, main, spectator } = roomShowingBothOccupants();

    // The wrong order: the newcomer is seated, then the clear sweeps him out.
    const newcomer = new Player();
    newcomer.score = NEWCOMER_SCORE;
    room.state.roster.set(YIN, newcomer);
    room.broadcastPatch();
    room.state.roster.clear();
    room.broadcastPatch();

    const mainBodies = main.takeBodies();
    const spectatorBodies = spectator.takeBodies();

    // On the wire this is the seat (13) followed by the clear (3) — and both
    // screens finish empty. Not the ending the beat requires.
    assert.deepStrictEqual(mainBodies, [13, 3]);
    assert.deepStrictEqual(spectatorBodies, [13, 3]);
    assert.deepStrictEqual(main.roster(), []);
    assert.deepStrictEqual(spectator.roster(), []);
  });

  it("rejected: bringing 子 and 丑 back alongside 寅 is not a clear", () => {
    const { room, main, spectator } = roomShowingBothOccupants();

    // Clear the occupying seats but forget to keep them gone.
    room.state.roster.clear();
    const zi = new Player(); zi.score = 5;
    const chou = new Player(); chou.score = 9;
    const yin = new Player(); yin.score = NEWCOMER_SCORE;
    room.state.roster.set(ZI, zi);
    room.state.roster.set(CHOU, chou);
    room.state.roster.set(YIN, yin);
    room.broadcastPatch();

    main.takeBodies();
    spectator.takeBodies();

    const expected = [[ZI, 5], [CHOU, 9], [YIN, 13]];
    assert.deepStrictEqual(main.roster(), expected, "old occupants must not reappear");
    assert.deepStrictEqual(spectator.roster(), expected);
    assert.notDeepStrictEqual(main.roster(), THE_ANSWER);
  });

  it("rejected: 13 folded into 12", () => {
    const { room, main, spectator } = roomShowingBothOccupants();

    room.state.roster.clear();
    const nearly = new Player();
    nearly.score = 12;
    room.state.roster.set(YIN, nearly);
    room.broadcastPatch();

    main.takeBodies();
    spectator.takeBodies();

    assert.deepStrictEqual(main.roster(), [[YIN, 12]]);
    assert.deepStrictEqual(spectator.roster(), [[YIN, 12]]);
    assert.notDeepStrictEqual(main.roster(), THE_ANSWER);
  });

  it("rejected: an old occupant's score written onto 寅", () => {
    for (const stale of [5, 9]) {
      const { room, main, spectator } = roomShowingBothOccupants();

      room.state.roster.clear();
      const wrong = new Player();
      wrong.score = stale;
      room.state.roster.set(YIN, wrong);
      room.broadcastPatch();

      main.takeBodies();
      spectator.takeBodies();

      assert.deepStrictEqual(main.roster(), [[YIN, stale]], `score ${stale} is the old occupant's, not 寅's`);
      assert.deepStrictEqual(spectator.roster(), [[YIN, stale]]);
    }
  });
});
