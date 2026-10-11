# Hearth: the cozy dashboard

Claude Code's own Clawd sits on the left of the band and his pose carries the
moment. He blinks and looks over at what Claude reads. He taps a claw while
Claude edits and steps in place while a command runs. When a turn lands he
raises his arms, does a little hop and a shuffle, and a sparkle twinkles beside
him. He sweats now and then when the context runs high, naps when you are away,
and spins round and winks with a heart when you pet him. Beside him, three calm
lines tell you where you are, how full things are and what is happening. They
keep their places, and they change only when the session does. The passing of
time belongs to Clawd.

## The layout

```
 ▐▛███▛█      agent-plugins on claude/first-mod · 3 changed               Opus 5.5
▝▜██████▀     context ━━━━━━━━━━━━━━━━ 42%    5h limit ━━━━━━━━━━ 23%        $0.31
 ▝▝   ▝▝      Editing register.tsx                                     3 of 7 done
```

| Line | Left | Right |
|---|---|---|
| 1. Where you are | project (bold) `on` branch, `·` *n* changed (dim) | model, in Claude's clay |
| 2. How full things are | `context` meter and percent, `5h limit` meter and percent | cost |
| 3. What is happening | the tool at work, a hiccup, the next todo, or how the last turn went | todo tally (`3 of 7 done`) |

- Cells: a 1-cell margin, Clawd (9), his marks column (4), a 1-cell gap, then
  the words, which start 15 cells in. The marks column's first cell holds only
  the bead of sweat, a cell clear of his head (his own last cell is where a
  raised claw goes). The sparkle and the z start a cell further out. The heart
  fills the column, its first half cell empty, so it keeps clear of his claw.
  With nothing beside him the words sit five cells from his body, close enough
  to read as his.
- The words sit in a panel of fixed width per band width, so the right-hand
  figures stay put however long a line gets. It is 68 cells at 100 columns. It
  grows by a quarter of every column past 100 (78 at 140) and is capped at 80,
  so the model and the cost stay near their lines. Below 85 columns it takes
  all the room there is, still 2 cells short of the edge. Below 33 columns
  Clawd holds the band alone.
- Labels are lowercase and dim (`inactive`) on both surfaces. Values are plain
  text. Claude's clay (`claude`) is Clawd's voice: the model, the context meter,
  a hiccup, "Getting full".
- The meters are one even track (`━`), filled in clay for the context and in a
  quiet grey for the limit. Each number hugs its meter (`━━ 42%`) and pads after
  itself to four cells, so nothing after it moves as digits come and go. Only
  the number turns amber (`warning`, bold), past `warnAt` or past 80% of the
  limit.
- Bold never sits right beside dim text: Ink closes both with the same reset
  (SGR 22), and under truncation one can bleed into the other. A plain space
  always comes between the bold project and the dim `on`, and a warm figure's
  padding is its own plain run. A test reads every line, leaf by leaf, on both
  surfaces.

### Every line fits, at every width, on both surfaces

Each line has its forms, longest first (`hooks/words.ts`, shared by both
surfaces). The terminal measures them in cells (wide CJK characters and emoji
count two, combining marks none, and a symbol followed by U+FE0F counts two;
see `cells()` in `hooks/clawd.ts`); the desktop measures the very same forms in
pixels (below). The first form that fits the panel is drawn. Parts drop whole,
so nothing ever cuts a figure or a label. Only a branch, a file name or a todo
may be cut, at its end, and only once at least 6 cells of it still show.

- Line 1: with the model first. The whole branch with `· 3 changed`; then the
  branch without its prefix (`first-mod`) with `· 3 changed`, `· 3 files` or
  `· 3`, so the branch still shows whole; then that branch cut, but beside the
  model only while 8 cells of it still show (`first-mo…`, never `first…`).
  Then all of that again without the model, then the project and its count,
  and last the project cut.
- Line 2: the meters shorten (20 and 12 cells, only when the panel has 76 or
  more; then 16 and 10, 12 and 8, 8 and 5). Then `5h limit` becomes `5h`, then
  the meters go and the figures stay, then the cost goes, then the 5h figure.
  The context figure always stays. So at 78 to 82 columns, where the old fixed
  meters cut the 5h figure to `23…`, the meters shorten a step instead and
  every figure shows whole. Even with `$123.45` and 100% figures, the meters,
  both figures and the cost all show from 64 columns up, all three figures
  from 50, and the 5h figure from 38.
- Line 3: the tally shortens first (`3 of 7 done`, `3/7 done`, `3/7`), then
  the words lose detail beside the shortest tally, then the tally goes before
  the words are cut. Each step only takes away, so a narrower band never says
  more than a wider one (the words no longer flip between `Near the 5h limit`
  and `Near 5h limit` as the width changes). Each message has its own shorter
  forms (`Thinking it through`, `Thinking`; `Near the 5h limit · resets in 2h
  10m` down to `Near 5h limit`; `Done in 41s · 7 tools · 2 files changed` down
  to `Done`).

A part Ink must cut sits in a box exactly as wide as what shows of it plus
Ink's ellipsis. So a cut that would end inside a wide character (a CJK branch,
an emoji todo) lands on a cell boundary instead, and no stray blank cell opens
up before `· 3`.

A test walks every column from 34 to 160, with a long branch, a long file name,
`$123.45` and 100% figures, at work, landed with a full context and near the
5h limit. It checks every line in cells and that no figure is ever squeezed.
Another runs a CJK branch and an emoji todo through the same widths and checks
that every cut lands on a cell boundary.

### The desktop's lines, measured in pixels

On the desktop the same composition is a vector Clawd beside three Box/Text
lines, with the meters as rounded Svg pills. The words sit in a panel of
`columns - 14` cells, at most 64, beside Clawd's 96 px and a cell of gap (under
16 cells, Clawd keeps the band alone). Text there is a proportional font, so
the forms are measured in pixels, and generously: every glyph at the widest of
three common UI fonts (Inter, DejaVu Sans and Liberation Sans, which has
Arial's metrics), regular and semibold, with CJK and emoji at 18 px; a cell at
7.6 px, a little under the 7.8 px measured in a desktop preview. A form
fits when it fits that budget, so on the real page it has room to spare.

- Line 2 has forms of its own: the pills shrink (72 and 48 px, then 56 and 36,
  then 40 and 24), then `5h limit` becomes `5h`, then the pills go and the
  figures stay, then the cost goes, then the 5h figure. The context figure
  always stays. Nothing on this line sits in a box that clips: each percentage
  is in a box 5 cells wide (room for "100%", so the 5h group never shifts) that
  never shrinks, and the chosen form fits. With `$123.45` and 100% figures,
  the 5h figure shows from 38 columns, the cost from 48, the pills from 58,
  `5h limit` in full from 63 and the 72 and 48 px pills from 70; with
  everyday figures the pills show from 55 to 57 columns and the 72 and 48 px
  pills from 67 to 69.
- Lines 1 and 3 use the terminal's forms. Their words are one Text, so their
  spaces are the font's own; a branch, a file name or a todo that must be cut
  is cut here with an ellipsis, and only that box may clip. The model and the
  todo tally sit in boxes of their own that never shrink.

A test walks every column from 34 to 160 with `$123.45` and 100% figures, at
work, landed, with a full context and near the limit. It lays each line out as
the band budgets it and checks it fits the panel, that no box that clips holds
a figure, that line 2 has no box that clips at all, and that each figure and
label is whole or gone. Painted in Chromium, the same sweep and a grid of
everyday figures show nothing clipped, nothing past the panel and no ellipsis
on any figure, in both themes.

Clawd's Svg is 96 x 64 px (4 px a unit, `crispEdges`). He stands in its lower
left, and the room above him and to his right (20 px of it) holds his
sparkles, z, sweat and heart. Every extra stays inside that frame, at every
point of its motion; a test parses the source and checks this.

## What each moment looks like

| Moment | Terminal Clawd | Desktop Clawd | Line 3 |
|---|---|---|---|
| Fresh session | waves one claw twice, holding it up a moment each time, once a session (not again when a dialog hides the band and it comes back) | waves twice, once a session | Ready when you are |
| Idle | still; a blink every 5 to 6 s, a 1 s glance at the words every 20 s | the same, in CSS | Done in 41s · 7 tools · 2 files changed |
| A turn lands | arms up with a `✶` beside his claw, a shuffle (one foot pair, then the other), a dip (arms down, the sparkle a small `✢`), arms up again with `✻`. 4 s | arms up, a hop, a dip, arms up and a second hop, two clay four-point sparkles twinkling. 3.2 s | "Done" in `success` and the turn's summary, even with the context full: while he cheers the words say what finished, and "Getting full" (or "Near the 5h limit") comes back as the cheer ends |
| Esc, or a turn the model declined | no cheer | no cheer | Stopped after 12s (dim) |
| An API error ended the turn | no cheer | no cheer | Stopped on an error after 12s |
| Reading, searching, fetching | eyes open is home: as a read starts he looks over at the words for 2 s, then rests with his eyes on you, with a blink now and then, and looks over again every 10 to 16 s | at work (below) | Reading clawd.tsx |
| Thinking (no tool) | eyes on you; a slow glance away or a blink every ~5 s | at work | Now *in-progress todo*, or Thinking it through |
| Editing, writing | taps a claw twice, half a second up each time, then rests (a 4 s beat) | at work | Editing register.tsx |
| Running a command | a step (one foot, the other, half a second each), then a rest | at work | Run the tests (a described command is its description alone) |
| At work, on the desktop | | one loop for every tool, 8 s: a claw taps twice, he rests, glances at the words (his pupils move a pixel along the eye row), rests and blinks | |
| A tool failed | squeezes his eyes shut, then glances away, as the hiccup goes up | the same | Hiccup · Run the tests (clay, not red), for a second at least, whatever starts next |
| Context past `warnAt` | a blue bead forms beside his head, a cell clear of it, and slides down: every 8 s at work, every 16 s idle | a blue drop forms at his head's corner and slides, stopping above his claw: every 8 s at work, about every 19 s idle | Getting full · /compact when you are ready (and the toast, once) |
| Near the 5h limit | | | Near the 5h limit · resets in 2h 10m (the desktop says "/usage shows when it resets": nothing ticks there, and a stale countdown would mislead) |
| Idle 3 minutes | eyes closed; one dim `z` drifts up and away every 4 s; no sweat | eyes close by themselves 3 minutes after his Svg appears, and a redraw at 3 minutes draws him asleep; one soft z rises and grows; the drop stops | unchanged: he naps, the words don't |
| Petted (click / hover) | turns all the way round through Claude Code's 13 turning frames (a frame a tick, 3.25 s), then winks with his arms up and a pink pixel heart (`▗█▟▙` over ` ▀▛▘`) beside him for a second; his arms come down and the heart floats up a row for 1.5 s | on a hover that rests on him 150 ms: winks, arms up, hops twice; a soft pink heart rises and fades, twice, then he simply winks (a pointer left on him does not keep releasing hearts) | unchanged |

### Quick tools: one calm stretch of work

Claude often runs reads and searches in quick bursts. The band never flickers
through them.

- On the terminal, what the band shows of the work (line 3 and the pose that
  goes with it) stays up at least a second. A pause between tools shorter than
  three quarters of a second is no pause, and what is shown moves on only on a
  tick of the 250 ms frame clock. A turn that lands shows at once, so the cheer
  is never late. A flinch starts on the tick its hiccup goes up.
- On the desktop, which has no frame clock, the hooks module holds the words
  the same way: a tool's words stay up at least a second, a short pause is no
  pause, and `$.clock.after` looks again when a hold runs out. The first tool
  after a prompt shows at once.
- Clawd's Svg is built from slow state alone: one `work` mode for reading,
  editing, running and thinking, plus the cheer, the hello, the flinch, the full
  context and calm. A tool starting or finishing hands the page the very same
  Svg, so his iframe never reloads and his motion carries on undisturbed.
- A failure owns line 3 for its second. Its hiccup goes up as soon as what is
  shown has had its own second (at once, when what is shown is the very tool
  that failed: the line keeps its subject and says it stumbled), stays a second
  whatever starts next, and only then gives way. Clawd flinches as it goes up,
  on both surfaces, so he never flinches under another tool's name.
- When a turn ends, the band waits for the turn's own write. Should Claude
  Code say the work is over a moment before it lands, the band goes on showing
  the work (a second and a half at most, then it settles by itself). So the
  terminal never flashes the last turn's words, and the desktop goes from work
  straight to the cheer, one reload, not idle and then cheering.
- A test runs a burst: six tools of 60 ms, 60 ms apart. The terminal
  changes at most three times (it changes twice: to the tool, then back to
  thinking). The desktop keeps one Svg source, and every set of words stays up
  at least a second. Another runs a burst with a failure in it: the hiccup
  names the tool that failed for a second, and the flinch starts with it.

### Eyes open is home

While Claude works, Clawd looks at you. The brand's sideways eyes put the
pupils in the top quadrants, and held for long, on a dark terminal, they read
as notches bitten out of his head. So they are a glance, never a resting
place. Reading, he looks over at the words for 2 s as the read starts, then
again every 10 to 16 s (a deterministic dice, so a frame is a function of the
tick). A read that starts within 8 s of his last look does not earn another.
Thinking, he glances away for a second every 16 s. A test walks a minute of each
kind of work and caps the sideways time at 30%. Measured: reading 17%, thinking
7%, editing and running none. On the desktop his glance moves the pupils a
pixel along the eye row, so it never notches his head; that stays.

### The bead of sweat

The bead comes on ticks 8 to 13 of its cycle, every 8 s at work and every 16 s
idle (the "Getting full" line already says it). It shows only in a quiet
stretch: his pose must hold still from two ticks before the bead to two after
it. So it never meets a raised claw, a step, a blink or a look over at the
words, and it never makes a flurry of changes. It is the theme's own blue
(`ide`), which reads on dark and light themes and follows a custom one. On the
desktop the drop keeps his loop's time: from 2 s to 4.5 s of it, in the rest
after the tap and before the glance at work, and in the rest before the first
blink idle. Tests read the keyframes and check the drop never overlaps the
raised claw, a glance or a blink.

Calm is one pose per moment, with nothing moving inside a moment. You get it
from `/band still`, from Claude Code's `prefersReducedMotion` setting and, on
the desktop, from the page's `prefers-reduced-motion`.

- He still cheers (arms up, sparkle shown), flinches (eyes shut for the whole
  flinch, 1.5 s, on both surfaces) and naps (eyes close at 3 minutes, a static z).
- He shows a static bead of sweat (on the desktop it waits for a cheer to end,
  as his claws are up beside it), and petted, the wink and the heart without
  the spin or the float.
- No blinks, taps, steps, hops or drifting.
- The setting is read again with each prompt and on `/band`, so a change in
  `/config` takes hold without a restart. `/band hearth` says so when the
  setting still keeps him calm.

On the desktop the calm timing is written into the same Svg under
`@media (prefers-reduced-motion: reduce)`, not as `animation: none`, so Clawd
still naps there.

In Apple's Terminal he is Claude Code's simpler Clawd: his eyes are drawn into
a solid head and he has no arms, as Claude Code itself draws him there. He has
no turning frames there either, so a click is the wink and the heart.

## Decisions against the old band's glitches

- **Desktop shredding.** The desktop never gets a `Client` and never sees a
  block glyph. The hooks module draws a Box/Text tree with an `Svg` Clawd built
  from his pixel form (`isInteractive` so CSS animates him and `:hover` pets
  him; no script). Clawd is pixels; his feelings around him (the sparkles, the
  z, the drop, the heart) are soft smooth shapes, one language for each. Every
  Svg color reads on both claude.ai backgrounds: the clay body, near-black eyes
  on that body, pink, sky blue, warm greys. Words are never aligned with
  spaces; flex does it.
- **Desktop has no frame clock, and a new source reloads the frame.** Clawd's
  timing lives in his stylesheet. Each moment is a list of `[seconds, pose]`
  steps compiled to `step-end` opacity keyframes per body part. One-shot tracks
  (wave, cheer, flinch) come first, then the loop, then the nap as a held track
  180 s after the Svg appears. The source is a pure function of slow state
  (the mode, cheer, wave, flinch, high, still), never of a clock reading or of
  which tool is running. When a moment ends with nothing else to redraw the
  band (the cheer's 4 s, the flinch's 2 s, three idle minutes), the hooks
  module nudges `$.state` once by `$.clock.after`, and Clawd settles. Tests
  check the same source across a redraw in one moment and across tools.
- **Petting by accident.** The hover pet waits for intent: the petted Clawd
  and his heart show only after the pointer has rested on him 150 ms (a
  `transition-delay`), so a pointer passing on its way to the composer does
  not set him off. Leaving takes him back at once.
- **A host that inlines the Svg.** Every class and keyframe in his Svg starts
  with `hh-`, so nothing in it can meet a page's own styles. A test checks
  every class, selector, keyframe and animation name in several moments.
- **Rows padded to the full width.** No row is padded. Clawd's column is 9
  cells and his marks 4. The words sit in a fixed panel that ends at least 2
  cells short of the band. Every line is a `height={1}` Box with
  `overflow="hidden"`, the words in `wrap="truncate-end"` as a backstop, and
  each line is composed to fit (above).
- **Ambiguous and emoji symbols.** Only Clawd's own block elements and turning
  frames, box drawing (`━`), ASCII, `·` and Claude Code's `✶ ✻ ✢`. The heart is
  seven block elements, and the branch is the word "on". A test walks every
  terminal frame at every width and checks this. What the person's session
  brings (a CJK branch, an emoji in a todo) is measured in cells, never by
  `String.length`.
- **Redrawing 8 times a second.** One 250 ms frame clock. A tick composes the
  frame and calls `setState` only when it differs from the frame on screen. The
  call that draws new props records what it drew, so new props never cost a
  second, identical frame. A test drives the module directly and counts the
  `setState` calls. Idle, nothing changes for seconds at a time. At work, a
  claw tap or a step holds each position half a second, on a 4 s beat. Tests
  walk 16 s of editing and of running with the context high, and a minute of
  each kind of work: never three changes running, never more than four a
  second.
- **A second spinner under Claude Code's.** The band has no spinner and no
  whimsical verb. While Claude thinks or reads, Clawd holds his gaze on you.
  Line 3 names the concrete thing ("Editing register.tsx", "Run the tests")
  that the spinner above does not.
- **Eyes hard-coded black.** Every Clawd color is a theme key: `clawd_body`,
  and `clawd_background` for pupils, lids and the body row, as CLAWD.md lays
  them out. The bead of sweat is `ide`. Raw hex is used only for the heart
  (#E86A92), which no theme key covers, chosen to read on dark and light
  terminals.
- **A second hello.** The hooks module notes when the band first draws in a
  session, and only in the next 5 s (before any turn) does Clawd wave. A dialog
  that hides the band and brings it back does not make him wave again.
- **A jumping prompt.** The band is always exactly 3 rows: the `Client` is
  `height={3}`, its root Box too, and every row is a 1-row Box. That holds in
  every moment and at every width, and a test checks it across frames, states
  and widths.
- **The band's bookkeeping failing.** The band only watches the prompt and the
  tools. Both hooks end in a replay-safe `.catch(($, e, next) => next(e))`: if a
  state write throws, the event goes on, and when the hook had already called
  `next`, the tool's own result is replayed (it never runs twice). `claude
  plugin validate` reports both as gating hooks with `.catch`, and a test breaks
  every state write mid-session and checks the prompt and each tool, failing
  or not, go on untouched.
- **Calm.** Amber appears only on the numbers that crossed a line. A failed tool
  is a "Hiccup" in clay, not a red alarm, set off from what failed by the band's
  own `·`. An interrupted turn is a dim "Stopped", never a green "Done" with a
  cheer. Session time was dropped (Claude Code shows it), and the reset
  countdown appears only when the limit is near.

## Data layer changes

`hooks/register.tsx` keeps the tested data layer and adds these:

- An activity `kind` (read, edit, run, web, plan, other) that picks Clawd's
  pose on the terminal.
- Bash shown by its description alone; a tool's text is kept to its first line.
- `slip`: the last tool that failed, kept until the next one starts;
  `lastSlip`, the same kept until the turn ends, so the terminal's band can
  hold its hiccup a second whatever starts next; `slipDue`, a failure whose
  hiccup has yet to have its second on the desktop; and `flinchAt`, when the
  desktop's hiccup went up (Clawd flinches with it).
- `held`: what the desktop's third line shows while Claude works, with the
  time it went up, stepped by the hold above. `toolEndedAt` tells a short pause
  from a real one.
- `isTurnOpen`: a prompt was sent and its turn has not been written down yet.
  With it, the render keeps showing the work when Claude Code says the work is
  over before the turn lands (at most 1.5 s, with one redraw at the end).
- `beat`: bumped when a moment ends with nothing else to say so, so the
  desktop redraws (the cheer over, the flinch over, the nap coming on).
- `lastTurn.ending` (`answer`, `stopped` for Esc or a refusal, `error`), so
  only an answered turn is "Done" and cheered.
- `isCalm` from `prefersReducedMotion`, read at session start, with each prompt
  and on `/band`; `isAppleTerminal` from `TERM_PROGRAM`. Both are safe to fail.
- `isGreeting` in the band's props: the band's first 5 s in the session, before
  any turn, so Clawd waves hello once.
- A stored state from an older build has its new fields filled in.

The styles are `hearth` and `still`. A saved style from the old build falls back
to `hearth`.

## Files

- `hooks/register.tsx`: data layer, `/band`, the desktop's hold, and the
  `AbovePrompt` render (terminal: the `Client`; desktop: `desk()`).
- `hooks/band.tsx`: the terminal surface module: the hold, the poses, the bead,
  line 2's meters, and the cell measure for every line.
- `hooks/words.ts`: each line's forms (where you are, what is happening, how
  the last turn went), shared by both surfaces, and the fit that picks one.
- `hooks/clawd.ts`: Clawd's terminal cells (eyes, arms, feet, the 13 turning
  frames, Apple's Terminal) and `cells()`, shared by the band and its tests.
- `hooks/desk.tsx`: the desktop drawing: the pixel measure, line 2's pills,
  and Clawd's Svg.
- `tests/session-band.test.ts`: 41 tests, with the UI tests looped over
  terminal and desktop. Beyond the moments themselves they cover: every width
  from 34 to 160 with long figures, measured in cells on the terminal and laid
  out in pixels on the desktop, with no figure in a box that clips; a CJK
  branch and an emoji todo, cut on cell boundaries; bold apart from dim; the
  a burst of quick tools (at most three terminal changes, one desktop Svg); a failure
  in a burst (the hiccup a second, the flinch with it); "Done" while he cheers
  with a full context; a turn whose write lands after Claude Code says the
  work is over; sideways eyes at most 30% of every kind of work, with glances
  every 10 to 16 s while reading; the bead clear of every claw, step, glance
  and blink on both surfaces, and the calm desktop bead waiting out a cheer;
  the spin, wink and heart; hover intent, the heart rising twice (not
  forever) and the `hh-` prefix; a broken state write never touching a tool;
  reduced motion read again on a prompt and on `/band`; `setState` only on
  changed frames, calm and through 100 s each of lively idle, editing,
  running, reading, a pet and a nap; the same desktop source through tools
  and redraws; extras inside the Svg frame; one hello a session; and a calm
  flinch held in one pose.
