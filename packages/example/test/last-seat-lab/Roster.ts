/**
 * "Last seat" lab — the room and state the acceptance test drives.
 *
 * A room starts with two occupants (子 score 5, 丑 score 9). One beat must
 * clear both and seat 寅 (score 13) in the same tick, so both screens — the
 * main client and the spectator (StateView) client — end with a one-line
 * roster: `寅 13`.
 */
import { type Client, Room } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";

export const ZI = "子";
export const CHOU = "丑";
export const YIN = "寅";

export const SEED: Array<[string, number]> = [[ZI, 5], [CHOU, 9]];
export const NEWCOMER_SCORE = 13;

export const Player = schema({ score: t.number() });
export type Player = SchemaType<typeof Player>;

export const RosterState = schema({ roster: t.map(Player) });
export type RosterState = SchemaType<typeof RosterState>;

/**
 * How the clear + seat is packaged:
 *   "atomic"   — both writes land in one tick, one patch (body 14 bytes)
 *   "two-step" — clear-only patch (body 3 bytes), then seat-only patch
 *                (body 13 bytes)
 */
export type BeatMode = "atomic" | "two-step";

/**
 * Room that owns the roster. No patch timer: the test calls `broadcastPatch()`
 * itself, so a beat is exactly the writes it made.
 *
 * `state` and `patchRate` are native class fields on purpose — the pattern the
 * rest of the suite covers in `Room.test.ts` ("state and settings as class
 * fields").
 */
export class RosterRoom extends Room<{ state: RosterState }> {
  state = new RosterState();
  maxClients = 8;
  patchRate = 0;

  onCreate() { }

  /** Seed the two starting occupants (stand-ins for their joins). */
  seed() {
    for (const [name, score] of SEED) {
      const player = new Player();
      player.score = score;
      this.state.roster.set(name, player);
    }
    this.broadcastPatch();
  }

  /**
   * The beat under test: drive 子 and 丑 out and seat 寅 at 13.
   *
   * Both modes leave the same room — only 寅, score 13. The difference is how
   * many patches carry it across the wire.
   */
  beat(mode: BeatMode = "atomic") {
    this.state.roster.clear();

    if (mode === "two-step") {
      // clear both occupants and ship that alone …
      this.broadcastPatch();

      // … then seat the newcomer, in its own patch
      this.seatNewcomer();
      this.broadcastPatch();
      return;
    }

    // atomic: clear + seat land in the same tick, so the patch clients
    // receive is one CLEAR followed by one ADD — no intermediate roster is
    // ever on the wire, or on either screen.
    this.seatNewcomer();
    this.broadcastPatch();
  }

  private seatNewcomer() {
    const newcomer = new Player();
    newcomer.score = NEWCOMER_SCORE;
    this.state.roster.set(YIN, newcomer);
  }

  onJoin(_client: Client) {
    // Occupancy here is driven by `seed()` / `beat()`, not by connections.
  }

  onLeave(_client: Client) {
    // See `onJoin`: connections do not own roster entries in this lab.
  }
}
