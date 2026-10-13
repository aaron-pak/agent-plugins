// The terminal bands' pace: at most four changes of the frame in any second, and every frame up for
// a tick at least. Both looks' surface modules keep one.
//
// The frame clock ticks every 250 ms, so a band that changes on every tick (the tide's spin, the
// hearth's petted turn) is at its four already; a change between ticks (a pet, a turn landing, a
// /band switch, a new reading) must find room for itself in the second before it. The module never
// knows when between two ticks a change lands, so each change is noted in half-tick slots: on the
// n-th tick at 2n, between it and the next at 2n + 1, and a change between ticks is counted as late
// as it may have come. A change finds room when the fourth change before it was a whole second
// earlier or more: at slot 2n - 8 or before, on the n-th tick or just after it. One with no room
// waits for the next tick that has it (see hasRoom).
//
// A frame put up between ticks keeps the next tick too: a tick that would change it holds, clock and
// all, so the frame shows for a tick at least and is never a flash of a few milliseconds (a pet's
// first frame, a turn's first words). A change between ticks that could as well wait (the hearth's
// next line) waits for the next tick unless the frame on screen has been up a whole tick (isSettled),
// so it never cuts short a beat the last tick put up.
//
// A tick holds once at most, never two in a row: a burst of changes between ticks (a turn written
// down while Claude Code still says it is working, then its word that it is not) stretches what
// plays by a quarter of a second, never stalls a spin for a whole one.

/**
 * `beat`: the ticks so far (the mount is tick 0). `slots`: the last four changes, oldest first.
 * `heldOn`: the last tick that held.
 */
export type Pace = { beat: number; slots: number[]; heldOn: number }

/** A band's first frame, on the clock's tick 0. */
export function newPace(): Pace {
  return { beat: 0, slots: [0], heldOn: -1 }
}

/**
 * A band put up by a look switch, in place of a look that may have changed on each of its last
 * ticks (a spin, a splash): its first tick holds if it would change, so the switch never makes a
 * fifth change in the second it lands in.
 */
export function switchedPace(): Pace {
  return { beat: 0, slots: [-5, -3, -1, 0], heldOn: -1 }
}

/** A tick of the clock. */
export function tick(pace: Pace): void {
  pace.beat += 1
}

/** Whether a change now (on this tick, or between it and the next) keeps every second to four. */
export function hasRoom(pace: Pace): boolean {
  const fourth = pace.slots[pace.slots.length - 4]

  return fourth === undefined || fourth <= 2 * pace.beat - 8
}

/**
 * Whether this tick, which would change the frame, holds instead: the frame on screen went up
 * between the last tick and this one, or the second has no room, and the last tick did not hold.
 */
export function isHeld(pace: Pace): boolean {
  const isJustUp = pace.slots[pace.slots.length - 1] === 2 * pace.beat - 1
  if (pace.heldOn === pace.beat - 1 || !(isJustUp || !hasRoom(pace))) {
    return false
  }
  pace.heldOn = pace.beat

  return true
}

/**
 * Whether the frame on screen has been up a whole tick at least, so that a change now, between two
 * ticks, cuts no beat short (a glance, a blink, a claw tap the last tick put up): the last change was
 * on the tick before this one, or earlier.
 */
export function isSettled(pace: Pace): boolean {
  return (pace.slots[pace.slots.length - 1] ?? -Infinity) <= 2 * pace.beat - 2
}

/** Notes a change of the frame, on this tick or between it and the next. */
export function spend(pace: Pace, isTick: boolean): void {
  pace.slots = [...pace.slots, 2 * pace.beat + (isTick ? 0 : 1)].slice(-4)
}
