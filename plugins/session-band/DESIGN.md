# Session band: Clawd above the prompt

`session-band` is a Claude Code mod, a function-hook plugin, that puts Clawd in a three-row band
above the prompt with the session at a glance: what is happening, how full the context is, and
where you are. It draws in the terminal and in the desktop Code tab, in one of two looks.

This page is for contributors: what the band does for a person, how it is built, and why the less
obvious choices were made. Nearly every rule here is held by a test in `tests/`; if you change a
rule on purpose, change its test and this page with it.

## Using it

- **What you see.** Clawd above your prompt, beside three short lines: what is happening, how full
  your context is (with the cost and whichever usage limit is nearest its end), and where you are.
- **`/band`** (also `/band help`, `/band ?`, `/band status`) says what is on and how to change it.
- **The look.** **tide** is the default: Clawd on a little beach, where the tide comes in from the
  right as your context fills, so how full it is reads as how much sand he has left. It should feel
  like a calm corner of a summer afternoon: mostly still, with something small happening now and
  then. **hearth** is the opt-out: Claude Code's own Clawd beside three calm lines that keep their
  places and change only when the session does. `/band hearth` and `/band tide` switch, and so does
  the "Band look" row of `/config`.
- **The motion.** `/band still` (or `calm`, or `quiet`) stops the motion in either look while the
  words keep changing; `/band lively` lets it move again.
- **Reduced motion wins.** With Claude Code's reduced-motion setting on, both looks stay still.
- **`warnAt`** (default 80) is the context fill, in percent, where the band nudges toward
  `/compact`: high tide on the beach, a clay percent and a sweating Clawd by the hearth, and a toast
  each time the context crosses it.

## Looks and motion

| Choice | Values | Where it lives | Changed by |
|---|---|---|---|
| Look | `tide` (default), `hearth` | the `look` field of `userConfig` (the "Band look" row of `/config`) | `/band tide`, `/band hearth`, `/config` |
| Motion | `lively` (default), `still` | the plugin's store (`motion`), kept across sessions | `/band still`, `/band lively` |

- **One home for the look.** `/band` writes the `/config` row through `$.config.set`, and nothing
  else stores a look. That write reloads the plugin, so `/band` also records a pick (`LookPick` in
  `$.state`) that the band draws at once, until the reload lands with the same look. A saved pick
  counts only in the activation that made it, so after any reload `/config` is the only voice. A
  pick `/config` could not save lasts the session, through reloads, while `/config` still holds the
  look it was picked over.
- **A switch never replays a moment.** The pick remembers when the look came on screen, and a
  moment that began before then (a cheer, a splash, a flinch, a wake, the hello) is not played by
  the look that comes on. The desktop opens at rest in one new frame; the terminal modules carry a
  moment on only while enough is left to read (6 ticks of a cheer, 4 of a splash). Going lively is
  the same: `/band lively`, or reduced motion turned off, notes `livelyAt`, and a lively desktop
  frame opens at rest rather than replaying a cheer the still frame was holding.
- **A look already on is no switch**: `/band tide` on the beach asks `/config` nothing.
- **Someone else changes the look** (the `/config` menu, or another plugin): the `config.set`
  observer shows the written value at once. The band's own `$.config.set` never reaches it.
- **Motion is written before the look**, since the look write reloads the plugin. A motion the
  store refuses is kept in `$.state` (`unsavedMotion`) and preferred by `session.start`, so a reload
  never undoes a `/band still` the reply promised.
- **Reduced motion** is read at session start, on each prompt and on `/band`, so changing it needs
  no restart. The desktop also honors the page's own `prefers-reduced-motion`.
- **Lenient words.** `/band hearth still` and `/band still hearth` both make one `/config` call and
  one motion change. Words split on spaces, commas and semicolons, and leading dashes and trailing
  punctuation fall away (`/band hearth,`, `/band --help`). `calm` and `quiet` mean `still`, and
  `beach` means `tide`. Unknown, doubled or clashing words change nothing and say what `/band` takes.
- **Where `/config` cannot help.** A folder loaded with `--plugin-dir` keys the row
  `session-band@inline.look`, which `/band` finds through `$.config.list()`. When `/config` refuses,
  the look stays and the reply quotes the reason. When it cannot be reached, the look switches for
  this session only, and the reply and the status line say so.
- **A look outside the options** (a hand-edited `cozy`) reads as unset, which is the beach.
- **Older builds** stored a `style`, where only `still` meant still. It becomes a motion once
  (`migrateMotion`), and the look is never read from it. Someone whose style was `hearth` lands on
  the beach and hears it once, in a toast: "Band: the beach is the new look. /band hearth brings the
  hearth back." Older `$.state` facts are filled in by `whole()`.
- **The toast** comes once per crossing of `warnAt`, rounded, in the look's own voice: "The tide is
  coming in: context is 86% full. Try /compact soon." or "Context is 86% full. Run /compact when you
  are ready."

### What `/band` says

Every reply is one plain line of at most 100 characters (a refusal quotes `/config`'s reason, which
may run longer), in the voice of the look on screen: what is on, then the one thing most worth
knowing next. After a switch that is the way back; after a motion, the way to the other. Each look's
sentences are written once, in `hooks/look.ts`.

| Command | Reply |
|---|---|
| `/band` | `Band: tide, lively. Look: /band hearth or /config. Motion: /band still.` |
| `/band`, reduced motion on | `Band: hearth, still for your reduced-motion setting. Look: /band tide or /config.` |
| `/band hearth` (a switch) | `Band: hearth. Clawd blinks, reads along and cheers. /band tide to switch back.` |
| `/band tide` (a switch) | `Band: tide. Waves lap the shore and Clawd potters about. /band hearth to switch back.` |
| `/band still` on the beach | `Band: still. The waves rest, and the tide shows your context. /band lively brings them back.` |
| `/band lively` by the hearth | `Band: lively. Clawd blinks, reads along and cheers. /band still calms him.` |
| `/band lively`, reduced motion on | `Band: lively once reduced motion is off; until then the beach stays calm.` |
| a look `/config` could not save | `Band: hearth (this session only); /config could not save it. /band tide to switch back.` |
| `/config` refused | `Band: tide, lively. /config kept the look: <its reason>.` |
| `/band off` (also `none`, `hide`, `disable`) | `Band: /plugin turns the band off. /band still stops the motion; /band hearth is the plainer look.` |
| `off` beside a look | `Band: hearth. /band tide to switch back. /plugin turns the band off.` |
| bad words | `Band: "cozy" isn't a look or a motion. Try tide, hearth, still or lively.` |
| the state cannot be written | `Band: couldn't switch just now. Try /band again in a moment.` |

Under reduced motion no reply points at a `/band lively` that would change nothing. When an off
note drops the look's own sentence, the way back names who moves (`ALONE`: "/band lively lets Clawd
move"), since a bare "him" would refer to nothing. `/band` is the one hook that answers the person
directly, so its body is guarded: a refused state write gives the last row, never silence.

## Manual live checks

The test kit cannot drive the host's own reload of a plugin's options, so check these by hand after
changing the look, the motion or the reload path.

- **Terminal:**
  1. `/band`: one status line.
  2. `/band hearth`: the reply arrives, the band switches to the hearth, and nothing jumps.
  3. `/band` again: it says hearth (the command survived `/config`'s reload).
  4. `/config`, then "Band look", then tide: it switches back, with no reply.
  5. `/band still`, then quit and restart: still is remembered, and the look comes from `/config`.
- **Desktop Code tab:** the same five. Both looks' frames are 64 px tall, so the composer should not
  move on a switch.
- **A switch right after a turn lands:** `/band hearth` while the beach cheers. The hearth should
  come on at rest with "Done in …", with no cheer replayed and no pop when the old cheer would end.
- **A reload that keeps the look (desktop):** with the beach on and Clawd walking, change `warnAt`
  in `/config`. The diorama should carry straight on, with no jump of Clawd or the water.
- **Esc mid-command:** start a slow command (`sleep 20`) and press Esc while it runs. Both looks
  should say "Stopped after …" with no "Splash!" or "Hiccup". A splash that flashes first means the
  host gave no interrupt word at the call's end (see "Known gaps").
- **If the `/band hearth` reply ever goes missing**, the reload is killing the hook mid-reply. The
  fallback is to answer first and call `$.config.set` from `$.clock.after(0, …)`, reporting a refusal
  or failure by toast.

## The shared data layer

`hooks/register.tsx` holds every hook. They write one set of facts (`Info` in `types/index.d.ts`) to
`$.state`, and the `ui.render` hook for `AbovePrompt` draws whichever look is on. Each look reads the
facts through a view that hands it exactly what its code was built to read (`tideInfo()`,
`hearthInfo()`). The pure rules live in `hooks/facts.ts`, which never touches the engine.

| Hook | What it does |
|---|---|
| `session.start` | Registers `/band`; reads the motion, usage, model, repo, git, reduced motion and `TERM_PROGRAM`, each on its own so one failed lookup never blanks the rest; arms the nap; shows the upgrade toast. Idempotent. |
| `session.measure` | Context, cost and limits; the `warnAt` toast. |
| `prompt.submit` | Opens a turn and reads the model and reduced motion again. |
| `tool.call` | Running tools, both held steps, todos, files changed, failures. Subagents' calls are left alone. |
| `turn.complete` | The last turn and the cheer; then git's branch and count off the handoff, so a slow `git status` never holds up the cheer. A git answer older than one already landed is dropped. |
| `session.end` (`clear`) | `/clear`: the facts and every moment start over. |
| `command.run` (`band`), `config.set` | `/band`, and looks changed elsewhere. |
| `ui.render` (`AbovePrompt`) | Draws the look; steps aside while Claude Code shows a survey there. |

**The facts.** Both looks share the model, project, branch and uncommitted count; the context
percent, tokens and window; the cost and the limit shown; when the session started and was last
active; the tools running (`running`, in start order, at most 32) and the one the band names
(`activity`, the latest still running); the todos (at most 256); the last turn and how it ended
(`answer`, `stopped` for Esc or a refusal, `error`); the cheer and failure counts; `isCalm`,
`isAppleTerminal`, `isTurnOpen`, `greetedAt`, `isWarned`, `unsavedMotion`; and `beat`, bumped when a
moment ends with nothing else to say so, which makes the desktop redraw. The hearth adds its
failure (`slip`, `lastSlip`, `slipDue`), its flinch and its held line (`held`). The tide adds the
turn's start (`turnAt`, `turnPercent`), whether the turn changed something (`turnWorked`,
`workedAt`), `woke`, its shown tool (`desk`), the cheer's time and tide, and the failure's words and
tide (`oopsWhat`, `oopsName`, `oopsNoun`, `oopsPercent`, `splashAt`, `waves`).

Rules the facts keep:

- **A step belongs to its turn.** A tool's end counts only while its id is still in `running`, which
  every prompt and turn end clears, so a command Esc left behind never splashes the next turn.
- **Tools overlap.** When the later of two ends first, the band goes back to the one still running
  (`runningAfter`), never to "Thinking it over" while a subagent works. A failure beside a running
  tool has its second, then the line goes back to that tool, and the failure is not brought back
  when it ends.
- **Esc is not a failure.** `tool.call` counts none when the dispatch was abandoned or the result
  holds Claude Code's "[Request interrupted by user" words (`isInterrupted`). Otherwise
  `turn.complete` with `aborted` takes back a failure from the last second of this turn (`ESC_MS`).
- **`/clear` ends the moments**: a band on screen drops its cheer or splash and says "Ready when you
  are" within a tick.
- **A wait on you is not work.** A question (`AskUserQuestion`) or a plan ready for you
  (`ExitPlanMode`) is the kind `ask`: Clawd rests, the words are dim, and one that ends in an error
  is the person declining, never a failure.
- **Todos.** A turn that finishes every todo leaves none, so the next plan counts from "0 of 2 done".

### Naming tools and cutting words

`describe()` names every tool once, for both looks: "Reading clawd.tsx", "Editing band.tsx",
"Searching for band", "Reading docs.example.com" (a WebFetch), "Listing hooks", a described command
as its description ("Run the tests"), and a subagent as "Delegating: Explore the hooks folder".
Another server's tool is "Using Linear: create issue" (`mcpName`, with a few brands spelled their
way). Claude Code's own tools have words of their own ("Asking you: Auth method", "Plan ready for
you", "Using the plugin-authoring skill", "Finding tools"), and any other is its name in words
("Using LSP"), never a code name. A set phrase is read whole, or gives way to a short form of 12
cells at most ("Searching", "Plan ready", "Using a tool": `phraseForms`).

The cutting rules are shared (`hooks/clawd.ts`):

- Words someone wrote (a described command, a todo, a subagent's task, a query) are cut only after a
  whole word (`isWordy`) and never end on a little word such as "the" or "why" (`trimLittle`):
  "Investigate why the build fails" reads "Investigate…". A cut that could only end on a little word
  is no form, and the line takes its next one.
- A raw command is never cut on a shell joint or on a flag that lost its argument (`trimJoints`).
- A name is never cut inside its extension (`.test.tsx` counts as one), is cut back to the end of
  one of its parts (`partCut`), and keeps at least 7 characters before the ellipsis.
- Times read as Claude Code's spinner writes them, "41s", "2m 14s", "1h 2m", each with a whole
  shorter form for a narrow band (`durationForms`).

### Held steps and the hold rules

Tools come in bursts; Claude Code's Reads and auto-accepted Edits take milliseconds. On both
surfaces what the band shows stays at least a second (`HOLD_MS`), and a pause under 0.75 s
(`GAP_MS`) is no pause, so the words never blink to "Thinking it over" between tools.

- The hooks module holds the step: `stepDesk` for the beach and `stepHeld` for the hearth. Each tool
  start and end steps both in the same state write (`settle()`), and one `$.clock.after` looks again
  at the sooner deadline. Both surfaces draw what the hold settled on, so they name the same tools,
  within a tick, however quick.
- A tool that starts and ends under another's second keeps a claim (`next`) and gets its second
  once the hold is over, if nothing else is at work and it says something new.
- A failure never waits behind the line. The beach drops a failed step's words at once for the
  splash; the hearth's hiccup takes over at once and keeps line 3 a second, whatever starts next.

### The terminal's pace

Both terminal modules tick every 250 ms and call `setState` only when the frame differs.
`hooks/pace.ts` keeps one budget: at most four changes in any second, and every frame up a tick at
least. A change between ticks (a pet, a turn landing, a `/band` switch) is counted in half-tick
slots and shows at once if the second has room, else on the next tick that has. A tick that would
replace a frame put up just before it holds once, never twice in a row. A new width never waits. A
beach swapped in under the hearth's band starts with `switchedPace`, counting the hearth's last
second as busy (the hooks tell a swap from a fresh mount by `e.requestId`, in `drawnLooks`). The
tests hold the idle beach to 0.3 changes a second and the nap to 0.15.

### Timers and redraws

The desktop has no frame clock, so every change it shows comes from a redraw the hooks module asks
for (`nudge`). Moments end with one redraw each: a cheer at 4.01 s (the hearth's) and 4.6 s (the
tide's), a splash at 3.1 s, a flinch at 3.01 s. The nap's comes a second after three quiet minutes.
While Claude works, the tide's stride of the water and the hearth's bead of sweat wait 400 ms
(`STRIDE_WAIT_MS`) before reloading the picture, so a reading just before the answer gives one new
frame, the cheer. A reload drops every timer, so each activation's first draw arms again what the
facts say is still to come (`pendingWakes`).

- **The landing.** Claude Code may say the work is over a moment before the turn is written down.
  Until it is, for 1.5 s at most (`LANDING_MS`), both looks go on showing the work, so neither
  flashes the last turn's words. The landing timer is let go both when it fires and when work
  resumes; each covers for the other, and a comment in `register.tsx` says to keep both.
- **The start.** Both looks start the turn as the prompt is written, for 1.5 s at most without the
  host's word, so a prompt that wakes a napping Clawd is one desktop reload, not two.
- **Robustness.** `session.start` and the gating hooks (`prompt.submit`, `tool.call`, `config.set`)
  end in `.catch(($, e, next) => next(e))`: a state write that throws leaves the event untouched,
  and a tool never runs twice. `ui.render` reads each record through `orNothing`, so a store that
  cannot be read still draws Clawd and his words.

## The tide (default)

### The beach

From left to right: a coral scallop shell, Clawd's home spot, the shore, and a strip of open sea
that is always there. The water covers the shore in proportion to the context used: at 0% a whole
wave rolls in at the far edge; at 100% the water comes up to a cell of sky from his side at home.

- **Palette:** kraft sand, a dusk-blue sea and a coral shell, muted so they sit beside Claude's clay
  on dark and light backgrounds. Terminal sand `#D9B482`, sea `#6C9DC2` over `#5888AE`, foam
  `#94BCDD`, shell `#E9A3A4`, heart `#E9789B`; the desktop's sand (`#E2C394`) and foam (`#C6DCEC`)
  are a touch lighter.
- **Ground:** a whole row of sand, so his legs stand in front of it. A darker grain every six cells
  hides only while he stands on or beside it. The two cells before the water are damp.
- **The wave** curls toward the beach, `▀▛█▄▄▖`, smaller with less room (`▀▛█▄▖`, `▀▛▖`), never cut
  mid-crest. The open sea (4 to 9 cells) is water the tide never needs, so a whole crest always
  shows. The shell (`▟▌▐▙` over `▝▀▀▘`) appears on beaches of 25 cells and up (56 columns).
- **The percent** is plain bold, and clay at high tide, the color of the `/compact` nudge beside it.
  A near limit and "Splash!" are clay too.
- A jump in the context rolls the water in a cell a tick on the terminal, never all at once.

**A cell of sky between Clawd and the wave.** His arm and the wave's lip are both top-half bars;
touching, they read as one bar and the wave loses its head. So he stands no closer than
`shoreline - 9 - 1`, the crest is drawn at the shoreline or a cell right of him, and when water runs
up to his feet only the ground row moves.

**Marks never cover the scene.** The heart, the cheer's sparkles, the nap's z and the splash's spray
each have places, best first, and take the first that is clear sky, a cell from the wave and the
shell; with none clear, the mark is left out. The heart is Claude Code's block heart (`▟▙▟▙` over
`▝▜▛▘`), or a three-cell `█▄█` over `▝█▘` on the narrowest beach with the tide in. With the tide in,
the crest stands back while the heart or the cheer's ✻ shows. Cheering from home, the lively spin
carries him a cell out (`stepOut`) so the ✶ has sky all round, and he pads home after.

**Eyes open is home.** Claude Code's glancing eyes (`█▟███▟`) put each pupil in the head's top
quadrant, which a dark terminal swallows, so held, Clawd looks eyeless. He rests with his eyes open
(`▛███▛█`) in every mood, and a look aside is short and about something: out to sea now and then,
at the words as a read starts (once in 12 s at most). After every moment he settles 3 s with open
eyes, since that is when a person looks at the band. The tests hold glances to 15% of the time idle
and 30% in other moods. The desktop moves a glancing pupil a pixel down onto clay instead.

### Each moment

| Moment | Terminal | Desktop |
|---|---|---|
| A new session | Half a second in, Claude Code's one-claw wave, twice. Never on a switch, a reload, still, or in Apple's Terminal. "Ready when you are". | The first frame waves by the shell, then idles; the wave is forgotten after a minute. |
| Idle | A blink every 19 to 31 s, a lap every 25 to 36 s, a 3 s look out to sea every 45 to 75 s, a short scuttle every 60 to 100 s. | A loop of about 27 s. |
| At work | He potters every 10 to 18 s. "Editing register.tsx · 3 of 7 done". | A reading loop until the turn changes something, then a work loop. |
| Turn finished | The 13-frame spin, then arms up with ✻ and ✶, 5 s in all. "✻ Done in 41s · 7 tools · 2 files changed", clay and green while he cheers. | The same in pixels; the sparkles pop and shrink, never fading. |
| Stopped, or an error | No spin. "Stopped after 12s" (dim), or "Stopped on an error after 12s". | No cheer; the same words. |
| A tool failed | Eyes shut, arms up, the water rushing to his feet with spray, then sliding back. 'Splash! "Run the tests" failed' for 3 s, then the same in dim. | The sea surges to his feet and back over 2.4 s. Each failure is a new frame (`data-wave`); one in the first 1.25 s rides along. |
| High tide | He backs up to the water's edge, and the water runs under his feet now and then. One toast. | The sea comes right up to him. |
| Nap (3 quiet minutes) | He walks home and curls up by the shell, a z rising. "Napping · last turn took 41s". | He walks home, curls up, then "z Z Z". One source for the whole nap. |
| Petted | A click: arms up and a wink, the heart 2 s. Asleep, he stays curled. | A hover that rests 0.15 s: a wink and a pixel heart. |
| Still | Nothing moves on its own: a cheer is one held pose, a nap is curled at once, a splash is its peak frame. | No keyframes; reduced motion puts every animation under `prefers-reduced-motion: no-preference`. |

### Narrow terminals

The beach widens with the band in steps, and the room for the words never shrinks as the band
grows (`layoutOf` in `hooks/tide/band.tsx`).

| Columns | Beach | Shore the tide covers | Room for the words |
|---|---|---|---|
| 130 and up | 40 cells, shell | 16 | 85 at 130, 95 at 140 |
| 122 to 129 | columns − 90, shell | 9 to 15 | 85 |
| 96 to 121 | 32 cells, shell | 9 | 59 at 96, 84 at 121 |
| 89 to 95 | columns − 64, shell | 4 to 9 | 59 |
| 56 to 88 | 25 cells, shell | 4 | 26 at 56, 58 at 88 |
| 52 to 55 | 22 to 24 cells | 5 to 7 | 26 |
| 45 to 51 | 22 cells | 5 | 19 to 25 |
| 41 to 44 | columns − 23 | 3 to 5 | 19 |
| 40 and below | 18 cells | 3 | 18 at 40, 12 at 34 |

Below 56 columns the shell goes and he stands a cell in from the edge; below 27 the words step
aside. At 34 columns every line still has whole words ("Ready", "Done in 41s", "Editing",
"Splash!", "86%"). A resize is taken up on the very frame that first shows it (`place()`): he keeps
his place relative to home, never stands over the shell, and a sleeper stays curled. In Apple's
Terminal the beach draws Claude Code's simpler Clawd, with no arms and no spin.

### What shows where

- **Line 1, what is happening:** the running tool or current todo, with the tally; after a turn, its
  time, tools and changed files, or "Stopped after 12s"; a failed tool, verdict first; "Next up:
  Write the tests"; the nap. No spinner, since Claude Code's own sits right above. The words are the
  hearth's for the same facts, so a switch changes the picture, not the vocabulary.
- **Line 2, the tide:** the percent, the `/compact` nudge when high, the cost (none until a cent is
  spent), and the limit (`limitShown`: the 5-hour one, unless another is at 80% or more and nearer
  its end), named "5h", "7d" or "spend". Past half, its reset as a time of day ("resets 4:57am"),
  which never goes stale. Before any reading: "No context reading yet".
- **Line 3, where:** the project, the branch, "N uncommitted" (git's count), the model.

Each line is a chain of forms, longest first, each taking something away (`hooks/tide/words.ts`);
`fitLine` draws the first that fits. So a narrower band never says more than a wider one. The
terminal measures cells (CJK and emoji two, the ellipsis two since its width is ambiguous); the
desktop measures pixels. A near limit outlasts the cost and the word "context"; at high tide the
nudge loses its dot ("86% try /compact") before it goes, never a bare "/compact". A failure steps
down one rung at a time (`nounsFor`). At 86% context with the 5-hour limit at 81%:

| Columns | Line 1, a failed tool | Line 2 |
|---|---|---|
| 102 and up | Splash! "Run the tests" failed | 86% context · try /compact · 5h limit 81% · resets 4:57am · $1.94 |
| 71 to 86 | Splash! "Run the tests" failed | 86% context · try /compact · 5h limit 81% |
| 57 to 59 | Splash! A command failed | 86% · try /compact · 5h 81% |
| 47 to 49 | Splash! A tool failed | 86% · try /compact |
| 38 to 39 | Splash! | 86% try /compact |
| 34 to 37 | Splash! | 86% |

After the splash, line 1 says '"Run the tests" failed' in dim, then 'A command failed', 'A tool
failed', and a bare 'Failed' only at 34 columns.

### Terminal and desktop

On the terminal, `hooks/tide/band.tsx` is the beach's `Client` module: exactly three rows, none
padded, built from block elements, ASCII `z`, ✻ ✶ · and the ellipsis. Clawd uses the theme keys
`clawd_body` and `clawd_background`; the beach colors are accents no theme key covers.

On the desktop, `hooks/tide/desk.tsx` draws an `Svg` diorama beside Box and Text words. Clawd is
converted quadrant by quadrant from the terminal's cell sprites, so both surfaces draw one Clawd
from one table. The frame is 64 px tall at every width, its 54 px scene 5 px from the top, in a
whole-pixel view (`viewBox="0 -5 192 64"`) drawn at `scale(3)`, so every edge lands on a pixel.
Below 48 columns the diorama narrows to `40 + 2 × (columns − 36)` units of 3 px, between 120 and
192 px. The words use the terminal's chains measured in pixels (`PIXELS`), with the room from
`bodyColumns` less the diorama and three cells of slack (`deskRoom`).

The `Svg` reloads its frame, restarting every animation, whenever its source changes, so the source
is built only from slow state, a `Scene`: the mood, the tide in 5% steps, still or not, a moment
while it plays, where he stands as it opens (`from`), the width, and for a splash which failure it
is (`wave`). The alt text comes from the Scene too and says the tide in words, never a number.

- A turn changes loop at most once, from reading to work. The tide holds through a turn at
  `turnPercent`, moving only in 15-point strides, and while a moment plays it holds where the
  moment began. No times go into the source.
- **Every new frame starts him where the last had him.** The hooks module remembers the last scene
  (`sceneMemory()`); `positionAt` reads his place in it, and the new frame opens with a lead
  (`leadOf`): the moment plays where he stands, then he scuttles to where the loop begins. A stride
  while he potters carries the loop's phase instead (`carriedPhase`).
- **The sea carries on.** Each Scene carries its sea, kept out of the source's key; `seaAfter`
  writes it as negative animation delays, so the water never snaps back. A rising tide waits for
  his walk back (`glideWait`).
- **A splash's frame goes on into the work**, so a turn that lands after a failure loads one frame.
- **Several desktops** keep one memory per width (`desktopScenes()`), and only the widest writes the
  kept copy, so two never take turns rewriting it.
- **The kept scene** goes to `$.state` from a `$.clock.after(0)` (a render cannot write), so a fresh
  activation keeps the frame on screen. The hearth clears it (`scene.forget()`).
- **Petting is CSS:** a hover that rests 0.15 s (`HOVER_S`) shows the pet pose and the heart and
  hides the sparkles and drops. Under the pointer his walk pauses; a moment plays on underneath.

## The hearth (opt-out)

Claude Code's own Clawd sits on the left. He blinks and looks over at what Claude reads, taps a claw
while Claude edits, and steps in place while a command runs. When a turn lands he raises his arms
and hops. He sweats when the context runs high, naps when you are away, and spins round and winks
with a heart when you pet him.

```
 ▐▛███▛█      agent-plugins on claude/first-mod · 3 uncommitted          Opus 5.5
▝▜██████▀     context ━━━━━━━━━━━━━━━━ 42%    5h limit ━━━━━━━━━━ 23%        $0.31
 ▝▝   ▝▝      Editing register.tsx                                     3 of 7 done
```

| Line | Left | Right |
|---|---|---|
| 1. Where you are | the project (bold), `on` the branch, `· N uncommitted` (dim) | the model, in clay |
| 2. How full things are | the `context` and `5h limit` meters and percents | the cost |
| 3. What is happening | the tool at work, a hiccup, the next todo, or the last turn | the tally (`3 of 7 done`) |

- **Cells:** a 1-cell margin, Clawd (9), his marks column (4) for the bead, sparkle, z and heart, a
  gap, then the words, 15 cells in.
- **The panel** has a fixed width per band width, so the figures stay put: 68 cells at 100 columns,
  plus a quarter of every column past 100, capped at 80. Below 85 columns it takes all the room, 2
  cells short of the edge; below 33 Clawd holds the band alone.
- **Color:** labels lowercase and dim; Claude's clay is Clawd's voice (the model, the context meter,
  a hiccup, "Getting full"). Only the number turns clay and bold, past `warnAt` or past 80% of the
  limit. A plain space separates bold from dim.

### Every line fits, on both surfaces

Each line's forms, longest first, are in `hooks/hearth/words.ts`, shared by both surfaces; the
terminal measures cells, the desktop pixels. Parts drop whole, so no figure or label is cut. Only a
branch, a file name, a command or a todo may be cut, at its end, while 7 characters of it show
(`LEAST`, 8 cells with the ellipsis).

- **Line 1:** the full branch, the count and the model; then the branch without its prefix; then
  the model goes; then the count goes, whole (never a bare `· 3`); then the branch is cut, then it
  goes, and last the project is cut.
- **Line 2:** the meters step down through four sizes, then `5h limit` becomes `5h`, then they go,
  then the cost, then the 5h figure. The context figure always stays. Before any reading it reads
  `context –`, never "0%".
- **Line 3:** the tally (`3/7 done` when short) goes before the words lose anything. Each message
  has shorter forms: "Thinking it over", "Thinking"; "Done in 2m 14s · 7 tools · 2 files changed"
  down to "Done"; "Stopped on an error after 12s", "Error after 12s", "Error".

On the desktop, Clawd is a 96 × 64 px `Svg` drawn from his pixel form and animated by CSS alone,
beside three Box/Text lines, with the meters as rounded Svg pills. The words sit in a panel of
`columns - 14` cells, at most 64; under 16 cells (30 columns) Clawd has the band alone. Forms are
measured at the widest of Inter, DejaVu Sans and Liberation Sans, against the panel as a page with
7.2 px cells would lay it out, so a line keeps a cell or more to spare. A name that must be cut is
cut with an ellipsis (`cutToFit`), and only its box may clip. The alt text is a full sentence:
"Clawd rests.", "Clawd taps along as Claude works.", "Clawd sits quietly while Claude works." when
still.

### What each moment looks like

| Moment | Terminal Clawd | Desktop Clawd | Line 3 |
|---|---|---|---|
| A new session | waves one claw twice, once a session | the same | Ready when you are |
| Idle | a blink every 4.5 to 7 s at no fixed beat; a glance at the words now and then | the same, in CSS | Done in 41s · 7 tools · 2 files changed, or Next up: *todo* |
| A turn lands | arms up with ✶, a shuffle, a dip, arms up with ✻, 4 s | arms up 3.2 s, two hops, two sparkles | "Done" in `success` while he cheers |
| Esc, or an error | no cheer | no cheer | Stopped after 12s, or Stopped on an error after 12s |
| Reading | looks at the words 2 s as a read starts (not within 12 s of his last look) | at work | Reading clawd.tsx |
| Thinking | eyes on you; a glance counted from when thinking began, so a turn never opens on one | at work | the todo at work, or Thinking it over |
| Editing, running | taps a claw on a 4 s beat, or steps in place | one 8 s work loop | Editing register.tsx, Run the tests |
| A tool failed | squeezes his eyes shut, glances away | the same, then a 1.5 s rest in the flinch's own frame, which stays up while the turn runs | Hiccup · Run the tests, at least a second |
| Past `warnAt` | a blue bead slides down, every 8 s at work, 16 s idle | a blue drop; it waits 400 ms while Claude works | Getting full · /compact when you are ready |
| Near a limit | | | Near the 5h limit · resets 4:57am ("At", "Over" past it) |
| Idle 3 minutes | eyes closed, a dim z drifts up | eyes close 3 minutes after the Svg appears, a slate z | unchanged |
| Petted | turns all the way round, winks with arms up and a pixel heart | a hover of 150 ms: a wink, a hop, the pixel heart; asleep, he sleeps on | unchanged |

A hiccup too narrow for its phrase never cuts a set phrase: it says what kind of step it was
("Hiccup · A command", "Hiccup · A tool"), and last "Hiccup" alone. On the terminal his pose and line
3 move together, so the held line goes up on a tick, or between ticks once the frame has been up a
whole tick (`Between`, from `isSettled`); a landing turn and a turn's start show at once. The
desktop's Svg is built from slow state alone (one `work` mode for every tool, plus the cheer, hello,
flinch, bead and calm), so a tool starting or finishing hands the page the same Svg. The bead comes
only in a quiet stretch, never beside a raised claw, blink or glance, in the theme's blue (`ide`).
Calm is one pose per moment: he still cheers, flinches and naps, without blinks, taps or hops.

## Key decisions and why

- **The desktop draws an Svg Clawd beside flex Box and Text, never a block-character `Client`.** The
  desktop draws Box as a flex div and Text as a span in a proportional font, so block-character art
  shreds and spaces cannot align words. Both looks draw Clawd as an `Svg` and lay the words out with
  flex, measured in pixels. The terminal keeps a `Client` per look, which owns its frame clock and
  draws exact cells.
- **The desktop source is built only from slow state.** A new source reloads the frame and restarts
  every animation, so anything that changes often stays in the words, and moments end with a redraw
  from the hooks module rather than a time in the source.
- **The hooks module holds the words, not the surfaces.** The desktop has no frame clock to hold a
  step by itself, and the terminal drawing the same held step is what makes both name the same tools.
- **One set of facts, a view per look, separate modules.** The facts are written once; `tideInfo()`
  and `hearthInfo()` are the seam. The `Client` keys differ (`band`, `hearth`), so a switch never
  hands one look's surface state to the other.
- **`/config` is the look's one home, and the store holds only the motion,** so a reload never finds
  two looks that disagree. `/band` is not marked `immediate`, which would let a switch reload the
  plugin mid-turn.
- **Both looks are 64 px tall on the desktop and three rows on the terminal,** so a switch never
  moves the prompt.
- **One warm color for one warning.** The theme's amber next to the clay nudge read as two alarms.
- **Bold never sits beside dim.** Ink closes both with one code, so a dim separator after bold text
  came out bold.
- **The looks write the figure differently on purpose:** on the beach the percent is what the tide
  stands for ("42% context"); on the hearth "context" labels a meter ("context 42%").
- **A described command is its description alone**, "Run the tests", never "Running: Run the tests".
- **A moment's source is not kept past its end**, except the hello's, whose key is the idle loop's:
  a remount within the keep would play the moment again.
- **The hearth's Svg classes start with `hh-`** in case a host ever draws it inline. The tide's
  Svg draws only in its sandboxed frame, and a prefix would change every tide source for no gain.

## Known gaps

- **Live reload is verified on the module side only.** The suite runs real new activations seeded
  with the last `$.state`, but cannot check whether Claude Code runs `session.start` again on an
  options-only reload, keeps `/band` registered, or lets the `/band` reply survive a reload.
- **Desktop widths are estimates.** A host that drew a 2-cell margin at 7.8 px beside 7.2 px columns
  would push two tide lines a pixel over; a font wider than the three measured would end a line in
  the page's ellipsis.
- **A fifth change in a second.** A look switch's first frame cannot wait (the old module is gone),
  so a switch just after the beach's spin changed on three ticks is a fifth change; the tick fires
  before the reply reaches the hooks. Two resizes in one second can do the same.
- **The cheer by the shell with the tide partway in** (56 to 95 columns): stepping out would leave
  the ✻ no sky, so he cheers at home and the ✶ sits a corner off the shell.
- **Below 34 columns the looks fall back differently**, and under 16 neither Clawd fits whole.
- **A `/model` shows at the next Enter.** No hook fires on it, so line 3 names the old model until
  the next prompt or turn end.
- **Two word fitters.** Both only take away and are tested at 34 to 160 columns, but a fix to one
  does not reach the other.
- **Turn-start order.** If the host ever said it was working before the prompt hook ran, the beach
  could draw one frame from the last turn's facts.
- **The hearth's desktop greeting reloads at 5 s** to drop the wave. Keeping the waving source would
  let a remount within the minute wave again.
- **The kept desktop scene lands a moment after its frame**, so a reload in that instant opens from
  the scene before.
- **Strides wait.** While Claude works, the tide's stride and the hearth's bead reach the picture
  0.4 s after the reading, and a rising tide waits for his walk back, so the picture can lag the words.
- **Esc with no word of it.** A host that marked neither the dispatch nor the result would show a
  splash or hiccup until the turn ends, under a second. An Esc whose turn ends more than a second
  after the call keeps its splash.
- **A frame's alt text says how the frame began.** A splash's or flinch's frame stays up through the
  work after it, and the hello's for its minute, so the alt names that moment.
- **The lively hearth's petted turn holds its first frame 500 ms**, since a pet shows between ticks
  and every frame stays a tick. The beach's spin does the same.
- **A pointer parked on him.** The hover pauses his walk, but the next frame opens where
  `positionAt` reads the unpaused walk, up to about 10 px away after a long hover. The hover never
  reaches the plugin.
- **The narrowest nudge** at 36 to 41 desktop columns (38 and 39 on the terminal) is "86% try
  /compact", without its dot.
- **The upgrade toast is for `hearth` only**; an older stored `still` gets the motion and no toast.
- **`/config`'s quoted reason** brings down the capital of a one-word name it opens on ("Okta").
- **The hearth desktop's panel stops at 64 cells**, so from about 90 columns a long raw command is
  cut there while the terminal shows it whole.
- **The water's glide is kept to a twentieth of a unit**, so a second failure in a splash's rush can
  open up to 0.2 px from where the last frame stood.
- **A wait on you:** whether the band shows beside Claude Code's own question is up to the host.
- **A glob's last part is one extension**, so "**/*.failing-fixture.ts" gives way to "Splash! A tool
  failed" and "Hiccup" rather than being cut inside it.
- **Ambiguous-width glyphs on the hearth:** its meters (`━`) and the dash of `context –` would shift
  line 2 on a terminal that draws them wide.

## Files

- `.claude-plugin/plugin.json`: the manifest, with the `look` and `warnAt` fields. It has no
  `version`; keep the marketplace entry's description in step with it.
- `tsconfig.json`: extends `.claude-plugin/types/tsconfig.json`, which the engine lays down.
- `types/index.d.ts`: the shared facts (`Info`), `Look`, `Motion`, `LookPick`, `KeptScene`.
- `hooks/hooks.json`: names `register.tsx` as the hooks module.
- `hooks/register.tsx`: every hook, the timers, the kept scene, and the render that picks the look.
- `hooks/facts.ts`: the facts' pure rules: `whole()`, `describe()`, `runningAfter`, the holds.
- `hooks/look.ts`: the look and `/band`: `parseBand`, `lookNow`, `migrateMotion`, `replyFor`.
- `hooks/clawd.ts`: Clawd's terminal cells, the shared palette, `cells()`, `textPx()`, the cuts.
- `hooks/pace.ts`: the terminal modules' one pace.
- `hooks/tide/band.tsx`: the beach's terminal module.
- `hooks/tide/desk.tsx`: the beach's desktop diorama, the Scene and its alt text.
- `hooks/tide/props.ts`: the beach's props, `sceneMemory()` and `desktopScenes()`.
- `hooks/tide/words.ts`: each beach line's forms.
- `hooks/tide/fit.ts`: `fitLine` and the `CELLS` and `PIXELS` measures.
- `hooks/tide/view.ts`, `hooks/tide/types.ts`: `tideInfo()` and the beach's types.
- `hooks/hearth/band.tsx`: the hearth's terminal module.
- `hooks/hearth/desk.tsx`: the hearth's desktop Clawd, pills and pixel budget.
- `hooks/hearth/words.ts`: each hearth line's forms and cuts, for both surfaces.
- `hooks/hearth/props.ts`: the hearth's props.
- `hooks/hearth/view.ts`, `hooks/hearth/types.ts`: `hearthInfo()` and the hearth's types.
- `tests/band.test.ts`, `tests/tide.test.ts`, `tests/hearth.test.ts`: the tests below.

## Tests

- `tests/band.test.ts`: the band as a whole: looks, `/config` and `/band` with every reply, the
  motion and the store, the migration, switches and reloads (fresh activations seeded with the last
  `$.state`), older state, the shared facts and holds, `describe()` and the cuts, git, `/clear`,
  Esc, and the terminal pace filmed to the 10 ms while a pet, a prompt or a switch lands.
- `tests/tide.test.ts`: the beach on both surfaces: the scene and its marks at every width from 34
  to 160, every moment, still and reduced motion, the calm budgets, the narrow words and splash
  ladder, and the desktop's source rules, read through `seekDesk`, which seeks his pose and place in
  the Svg's CSS.
- `tests/hearth.test.ts`: the hearth on both surfaces (each test runs with `look: hearth`): every
  line at every width from 34 to 160 in cells and pixels, every moment, the bead, calm, petting and
  the `hh-` classes.

UI tests loop over the terminal and the desktop; slow sweeps and films set their own `timeoutMs`.
From the repository root:

```
claude plugin validate plugins/session-band
claude plugin test plugins/session-band
```

`validate` warns that `plugin.json` has no `version`, and passes. To type-check, load the plugin
once with `claude --plugin-dir plugins/session-band` so the engine lays down
`.claude-plugin/types/`, then run `npx tsc --noEmit -p plugins/session-band`.
