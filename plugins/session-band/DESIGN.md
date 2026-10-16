# Session band: Clawd above the prompt

`session-band` is a Claude Code mod, a function-hook plugin, that puts Clawd in a three-row band
above the prompt with the session at a glance: what is happening, how full the context is, and
where you are. It draws in the terminal and in the desktop Code tab, in one of two looks.

This page is for contributors: what the band does for a person, how it is built, and why the less
obvious choices were made. Nearly every rule here is held by a test in `tests/`; if you change a
rule on purpose, change its test and this page with it.

## Using it

- **What you see.** Clawd above your prompt, beside three short lines: what is happening, how full
  your context is (with the cost and the usage limit closest to running out), and where you are.
- **`/band`** (also `/band help`, `/band ?`, `/band -h`, `/band status`, and a setting's own name
  alone, `/band look` or `/band motion`) says what is on and how to change it.
- **The look.** **tide** is the default: Clawd on a little beach, where the tide comes in from the
  right as your context fills, so how full it is reads as how much sand he has left; a calm corner
  of a summer afternoon, mostly still. **hearth** is the opt-out: Claude Code's own Clawd beside
  three calm lines that change only when the session does. `/band hearth`, `/band tide` (or `/band
  tidepool`) and the "Band look" row of `/config` switch.
- **The motion.** `/band still` (or `calm`, `quiet`, `stop` or `pause`) stops the motion in either
  look while the words keep changing; `/band lively` lets it move again.
- **Reduced motion wins.** With Claude Code's reduced-motion setting on, both looks stay still.
- **`warnAt`** (default 80): the context percent where the band nudges toward `/compact` (high tide
  on the beach, a clay percent and a sweating Clawd by the hearth, and a toast at each crossing).

## Looks and motion

| Choice | Values | Where it lives | Changed by |
|---|---|---|---|
| Look | `tide` (default), `hearth` | the `look` field of `userConfig` (the "Band look" row of `/config`) | `/band tide`, `/band hearth`, `/config` |
| Motion | `lively` (default), `still` | the plugin's store (`motion`), kept across sessions | `/band still`, `/band lively` |

- **One home for the look.** `/band` writes the `/config` row through `$.config.set`, and nothing
  else stores a look. That write reloads the plugin, so `/band` also records a pick (`LookPick` in
  `$.state`) that the band draws at once. A saved pick counts only in the activation that made it,
  so after any reload `/config` is the only voice; a pick `/config` could not save lasts the
  session, while `/config` still holds the look it was picked over.
- **A switch never replays a moment.** The pick remembers when the look came on screen, and a
  moment that began before then (a cheer, a splash, a flinch, a wake, the hello) is not played by
  the look that comes on. The desktop opens at rest in one new frame; the terminal modules carry a
  moment on only while enough is left to read (6 ticks of a cheer, 4 of a splash).
- **A moment belongs to the look and motion that saw it begin.** A beach switched to mid-splash
  opens at rest on the dim failed line on both surfaces (`isWaveSeen`), while the same look mounted
  afresh (a `/config` reload, a dialog closing) keeps "Splash!" to the wave's end. A cheer spins
  only on the look and motion it began on (`isCheerSpun`): back on the beach mid-cheer, or after
  `/band lively` in a still cheer, his arms stay up to its end (or he is at rest). Going lively
  (`/band lively`, or reduced motion turned off) notes `livelyAt`, so a lively desktop frame opens
  at rest, and on the terminal a still splash ends at once on the dim line of what failed.
- **A look already on is no switch**: `/band tide` on the beach asks `/config` nothing.
- **Someone else changes the look** (the `/config` menu, or another plugin): the `config.set`
  observer shows the written value at once. The band's own `$.config.set` never reaches it.
- **Motion is written before the look**, since the look write reloads the plugin. A motion the store
  refuses is kept in `$.state` (`unsavedMotion`), so a reload never undoes a promised `/band still`.
- **Reduced motion** is read at session start, on each prompt and on `/band`, so changing it needs
  no restart. The desktop also honors the page's own `prefers-reduced-motion`.
- **Lenient words** (`parseBand`). `/band hearth still` and `/band still hearth` both make one
  `/config` call and one motion change. Words split on spaces and on `, ; : = / -`, so
  `hearth-still`, `look=hearth` and `motion: still` read as meant. Quotes, backticks and brackets
  fall away (`/band "hearth"`, `/band <hearth>`), as do a leading `--`, a trailing full stop, a
  setting's name before a setting (`/band look hearth`) and a second `band` (`/band /band hearth`).
  `calm`, `quiet`, `stop` and `pause` mean `still`; `beach`, `tidepool` and `pool` mean `tide`; two
  words for one setting (`still calm`) ask for it once. Unknown or clashing words (`calm lively`)
  change nothing and say what `/band` takes, quoting the unknown word without its marks (`"cozy"`
  for `<cozy>`), or whole with no letter or digit in it (`/band ...` answers `"..."`), and cut with
  an ellipsis past 18 cells, so the reply stays on one line.
- **Where `/config` cannot help.** A `--plugin-dir` folder keys the row `session-band@inline.look`,
  which `/band` finds through `$.config.list()`. When `/config` refuses, the look stays and the reply
  quotes the reason; when it cannot be reached, the look switches for this session only.
- **A look outside the options** (a hand-edited `cozy`) reads as unset, which is the beach.
- **Older builds** stored a `style` (only `still` meant still), made a motion once (`migrateMotion`).
  Someone whose style was `hearth` or `still` (the still hearth) lands on the beach and hears it
  once, in a toast: "The beach is the new look. /band hearth to switch back." `whole()` fills in
  older `$.state` facts.
- **The toast** comes once per crossing of `warnAt`, rounded, in the look's own voice: "High tide:
  context is 86% full. Try /compact soon." or "Context is 86% full. Run /compact when you're
  ready." Toasts keep to the replies' 60 cells too, since the host shows them under the plugin's
  name as well.

### What `/band` says

Claude Code prints a command's reply after a prefix of its own, `  ⎿  session-band: `, which takes
19 cells. So every reply is one plain line of at most 60 cells (`REPLY_MOST` in `hooks/look.ts`): it
fits an 80-column terminal on one line with a cell to spare, should the host keep the last column
back, and no word is left alone on a second line at any width from 80 up. The prefix already names
the plugin, so a reply opens on what is on, never on "Band:". A word `/band` does not know is the
person's own, so the reply quotes it, cut with an ellipsis past 18 cells (the ellipsis counted as two,
since terminals differ on its width). The one exception is a refusal that quotes `/config`'s reason,
which may run longer. Its plain part comes first and always fits the line: what is on, the off note
if the words asked for it, and "/config kept the look:". What is on gives way to a shorter form
("Tide." for "Tide, lively.") when that lets the whole reply fit, unless the words asked for a
motion, which is news. When no form lets the whole reply fit, the shortest goes, so the reason wraps
as little as it can. The refusal is the news, so a look `/config` could not save before is not marked
"(session only)" there. So a wrap only ever moves the reason. A reason with no words in it ("",
"...") leaves the reply on "/config kept the look." with no colon dangling.

Every reply is in the voice of the look on screen: what is on, then the one thing most worth knowing
next, written once, in `hooks/look.ts`. After a switch that is the way back, or, when `/config`
could not save the look, why it lasts this session only (`/band` alone then gives the way back);
after a motion, the way to the other. `/band` alone lists the ways to change what is on, and short
of room drops them from the last, so the way to the other look stays longest; under reduced motion,
"still" gives up "for reduced motion" before that last way goes. With `off` beside a setting, the
reply keeps all it would say if that fits before "/plugin turns the band off.", else what is on as
the status says it ("Tide, lively.", or "Hearth, still." where reduced motion leaves no room for its
reason), else the look's name. `/band off` alone offers the quietest ways there are from what is on:
the hearth, and still. A band that is still already, by its motion or by reduced motion, is never
offered `/band still`, and a still hearth is as quiet as the band gets.

| Command | Reply |
|---|---|
| `/band` | `Tide, lively. Try /band hearth, /band still or /config.` |
| `/band`, reduced motion on | `Hearth, still for reduced motion. Try /band tide or /config.` |
| `/band hearth` (a switch) | `Hearth. Clawd blinks and cheers. /band tide to switch back.` |
| `/band hearth still` (a switch) | `Hearth, still. Clawd rests. /band tide to switch back.` |
| `/band tide` (a switch) | `Tide. Waves lap the shore. /band hearth to switch back.` |
| `/band still` on the beach | `Still. The waves rest. /band lively brings them back.` |
| `/band lively` by the hearth | `Lively. Clawd blinks and cheers. /band still calms him.` |
| `/band lively`, reduced motion on | `Lively once reduced motion is off; the waves rest till then.` |
| a look `/config` could not save | `Hearth (session only), still. /config couldn't save it.` |
| `/band` after that | `Hearth (session only), still. Try /band tide.` |
| `/config` refused | `Tide, lively. /config kept the look: locked.` |
| `/config` refused, a longer reason | `Tide. /config kept the look: locked by your organization.` |
| `/band hearth still`, `/config` refused | `Tide, still. /config kept the look: <its reason>.` |
| `/band hearth off`, `/config` refused | `Tide. /plugin turns the band off. /config kept the look: <its reason>.` |
| `/band off` (also `none`, `hide`, `disable`) | `/plugin turns the band off. Try /band still or /band hearth.` |
| `/band off` on a still beach | `/plugin turns the band off. Try /band hearth.` |
| `/band off` on a still hearth | `/plugin turns the band off. It's as quiet as it gets.` |
| `/band off` by the hearth, reduced motion on | `/plugin turns the band off. Reduced motion keeps it still.` |
| `off` beside a look | `Hearth, lively. /plugin turns the band off.` |
| `/band still off` | `Tide, still. /plugin turns the band off.` |
| bad words | `Try tide, hearth, still or lively, not "cozy".` |
| a long bad word | `Try tide, hearth, still or lively, not "incomprehensibil…".` |
| the state cannot be written | `Couldn't switch just now. Try /band again in a moment.` |

Under reduced motion no reply points at a `/band lively` that would change nothing, and no reply
offers a `/band still` to a band that is still already. "Him" and "them" come only after the words
that say who they are ("Clawd", "Waves"). `/band` is the one hook that answers the person directly,
so its body is guarded: a refused state write gives the last row, never silence.

## Manual live checks

The test kit cannot drive the host's own reload of a plugin's options, so check these by hand after
changing the look, the motion or the reload path.

- **Terminal:** `/band` gives one status line. `/band hearth` replies and switches, and nothing
  jumps. `/band` again says hearth (the command survived `/config`'s reload). "Band look" in
  `/config` switches back to tide, with no reply. After `/band still`, quit and restart: still is
  remembered, and the look comes from `/config`. In an 80-column window, the longest replies (`/band
  lively` under reduced motion, `/band off` on the beach) each print on one line.
- **Desktop Code tab:** the first five checks again. Both looks' frames are 64 px tall, so the
  composer should not move on a switch.
- **A switch right after a turn lands:** `/band hearth` while the beach cheers. The hearth should
  come on at rest with "Done in …", with no cheer replayed and no pop when the old cheer would end.
- **A reload that keeps the look (desktop):** with the beach on and Clawd walking, change `warnAt`
  in `/config`. The diorama should carry straight on, with no jump of Clawd or the water.
- **Esc mid-command:** Esc during `sleep 20` should read "Stopped after …" in both looks, with no
  "Splash!" or "Hiccup"; a splash first means the host gave no interrupt word (see "Known gaps").
- **If the `/band hearth` reply ever goes missing**, the reload is killing the hook mid-reply. The
  fallback is to answer first and call `$.config.set` from `$.clock.after(0, …)`, reporting a refusal
  or failure by toast.

## The shared data layer

`hooks/register.tsx` holds every hook. They write one set of facts (`Info` in `types/index.d.ts`) to
`$.state`, and the `ui.render` hook for `AbovePrompt` draws whichever look is on. Each look reads the
facts through a view that hands it exactly what its code reads, and nothing more (`tideInfo()`,
`hearthInfo()`). The pure rules live in `hooks/facts.ts`, which never touches the engine.

| Hook | What it does |
|---|---|
| `session.start` | Registers `/band`; reads the motion, usage, model, repo, reduced motion and `TERM_PROGRAM`, each on its own so one failed lookup never blanks the rest, and writes them before git answers; arms the nap; shows the upgrade toast; then writes git's branch and count, even if a step before it went wrong. Idempotent. |
| `session.measure` | Context, cost and limits; the `warnAt` toast. |
| `classic.PostModelSwitch` | The main loop's new model, on line 3 at once. |
| `prompt.submit` | Opens a turn and reads the model and reduced motion again. |
| `tool.call` | Running tools, both held steps, todos, files changed, failures, and the turn's count of tools, with its todo bookkeeping counted apart (`TODO_TOOLS`). Subagents' calls are left alone. |
| `turn.complete` | The last turn (its time, the tools it ran less its todo bookkeeping, the files it changed) and the cheer; then git's branch and count off the handoff, so a slow `git status` never holds up the cheer. A git answer older than one already landed is dropped. |
| `session.end` (`clear`) | `/clear`: the facts and every moment start over. |
| `command.run` (`band`), `config.set` | `/band`, and looks changed elsewhere. |
| `ui.render` (`AbovePrompt`) | Draws the look; steps aside while Claude Code shows a survey there. |

**The facts.** Both looks share the model, project, branch and uncommitted count; the context
percent; the cost and the limit shown; when the session was last active; the tools running
(`running`, in start order, at most 32) and the one the band names (`activity`, the latest still
running); the todos (at most 256); the last turn and how it ended (`answer`, `stopped` for Esc or a
refusal, `error`); the turn's tools and files (`turnTools`, `turnTodoTools`, `turnFiles`); the cheer
and failure counts; `isCalm`, `isAppleTerminal`, `isTurnOpen`, `greetedAt`, `isWarned`,
`unsavedMotion`; and `beat`, bumped when a moment ends with nothing else to say so, which makes the
desktop redraw. The hearth adds its failure (`slip`, `lastSlip`, `slipDue`), its flinch and its held
line (`held`). The tide adds the turn's start (`turnAt`, `turnPercent`), whether the turn changed
something (`turnWorked`, `workedAt`), `woke`, its shown tool (`desk`), the cheer's time and tide,
and the failure's words and tide (`oopsWhat`, `oopsName`, `oopsNoun`, `oopsPercent`, `splashAt`,
`waves`). Both held lines, `held` and `desk`, also carry the todos they show beside their step
(`todos`, `todosAt`).

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
- **The first frame already says where you are.** `session.start` writes the project (from the
  session's repo, or its folder) before it waits on git, and `ui.render` asks the repo and folder
  itself, once, if the band draws before even that. On both looks the line opens as the project
  alone. The branch and count from git join when it answers, at most 3 s later (its timeout), and the
  model joins with them (`isGitRead`, which a turn's git answer sets too, in case it lands first).
  On the beach the model stands after the branch, which would push it along. By the hearth it is
  pinned at line 1's right, but on a narrow band it is the first thing the line gives up for the
  branch, so a model drawn first would go when the branch came. So the line is never empty, and
  nothing on it moves or goes: it only grows. Waiting to draw until git answered would hold back
  Clawd's hello, and a placeholder would be one more thing to change.
- **A wait on you is not work.** A question (`AskUserQuestion`) or a plan ready for you
  (`ExitPlanMode`) is the kind `ask`: Clawd rests, the words are dim, and one that ends in an error
  is the person declining, never a failure.
- **Todos.** A turn that finishes every todo leaves none, so the next plan counts from "0 of 2 done".
  Keeping them (TodoWrite and the Task list tools, `TODO_TOOLS`) is bookkeeping, not a step, so
  "Done in 41s · 3 tools" counts the turn's other tools only.
- **A failure in a new turn has its own wave.** One in a wave's first rush (1.25 s,
  `SPLASH_RUSH_MS`) rides along with it only in the same turn (`isNewWave`).

### Naming tools and cutting words

`describe()` names every tool once, for both looks: "Reading clawd.tsx", "Editing band.tsx",
"Searching for band", "Reading docs.example.com" (a WebFetch), "Listing hooks", a described command
as its description ("Run the tests"), a subagent as "Delegating: Explore the hooks folder", and
another server's tool as "Using Linear: create issue" (`mcpName`, a few brands spelled their way).
Claude Code's own tools have words of their own ("Asking you: Auth method", "Plan ready for you",
"Finding tools"), and any other is its name in words ("Using LSP"), never a code name. A set phrase
is read whole, or gives way to a short form of 12 cells at most (`phraseForms`).

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
  start and end steps both in one state write (`settle()`), and one `$.clock.after` looks again at
  the sooner deadline, so both surfaces name the same tools, within a tick, however quick.
- A tool that starts and ends under another's second keeps a claim (`next`) and gets its second
  once the hold is over, if nothing else is at work and it says something new.
- A failure never waits behind the line. The beach drops a failed step's words at once for the
  splash; the hearth's hiccup takes over at once and keeps line 3 a second, whatever starts next.
- The step a splash hands the line on to counts its second from when the terminal can take it up:
  a tick past the wave's end, or for one that starts just after it, a tick after its start, at most
  two ticks past the end. With nothing to hand on, the quiet line of what failed goes up on a tick
  and stays one (`isQuietEnding`, `quietAt`); a step that starts sooner takes over from the splash.
- **A todo ticked off is no step of its own.** Each held line keeps the todos as they were when its
  step went up (`tallied`, in `stepDesk` and `stepHeld`; the views read them through `shownTodos`).
  A TodoWrite while the line is on its way to another step (`isMoving`) waits for that step, which
  brings the tally and the todo at work, so line 1 changes once ("Searching for band · 0 of 3 done",
  then "Reading clawd.tsx · 1 of 3 done"). With nothing on its way it shows after half a second
  (`TALLY_WAIT_MS`), and a new todo at work on a line with no tool has its second (`isTodoStep`). It
  never waits past two seconds (`TALLY_MOST_MS`). Out of a turn the list is as it is.

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
tide's), a splash at 3.1 s, a flinch at 3.01 s, and the nap a second after three quiet minutes.
While Claude works, the tide's stride and the hearth's bead wait 400 ms (`STRIDE_WAIT_MS`), so a
reading just before the answer gives one new frame, the cheer. A reload drops every timer, so each
activation's first draw arms again what the facts say is still to come (`pendingWakes`).

- **The landing.** Claude Code may say the work is over a moment before the turn is written down.
  Until it is, for 1.5 s at most (`LANDING_MS`), both looks go on showing the work. The landing
  timer is let go both when it fires and when work resumes; each covers for the other, so keep both.
- **The start.** Both looks start the turn as the prompt is written, for 1.5 s at most without the
  host's word, so a prompt that wakes a napping Clawd is one desktop reload, not two.
- **Robustness.** `session.start`, `prompt.submit`, `turn.complete` and `config.set` end in
  `.catch((_$, e, next) => next(e))`, and `tool.call`'s also takes a call that went wrong off the
  running list: a state write that throws leaves the event untouched, and a tool never runs twice.
  `ui.render` reads each record through `orNothing`, so an unreadable store still draws Clawd.

## The tide (default)

### The beach

From left to right: a coral scallop shell, Clawd's home spot, the shore, and a strip of open sea
that is always there. The water covers the shore in proportion to the context used: at 0% a whole
wave rolls in at the far edge; at 100% the water comes up to a cell of sky from his side at home.

- **Palette:** kraft sand, a dusk-blue sea and a coral shell, muted to sit beside Claude's clay.
  Terminal sand `#DAB27F`, damp sand and its specks `#B27F4C`, sea `#4C7FAF` with ripples
  `#004C7F`, foam `#7FAFD7`, shell `#E4A5A6` with ridges `#D97F7F`, heart `#E37DA2`. Each sits on or
  beside an entry of xterm's 256-color cube (180, 137, 67, 24, 110, 181, 174 and 175), so a terminal
  without truecolor shows the same beach (see "Key decisions"). The desktop keeps its own lighter
  colors: sand `#E2C394`, sea `#6C9DC2` over `#5888AE`, foam `#C6DCEC`, shell `#E9A3A4`, heart
  `#E9789B`.
- **Ground:** a whole row of sand, so his legs stand in front of it. A darker grain every six cells
  hides only while he stands on or beside it. The two cells before the water are damp, and so is the
  sand a splash ran over while it dries, but never the sand beneath him: his clay feet all but vanish
  on the damp tan (about 1.1 to 1), so the damp strip stops where he stands. The water itself still
  runs under his feet.
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
shell; with none clear, the mark is left out. With the tide in, the crest stands back while the
heart or the cheer's ✻ shows.

- **One heart**, Claude Code's block heart (`▟▙▟▙` over `▝▜▛▘`); a three-cell one reads as a pink
  "Y". Where it has no room a cell from him (the 18-cell beach, tide well in), he holds it flush
  against his raised claw, the wave standing back, and keeps the claw up while it shows, so its
  point never meets his lowered arm. With no room even for that, the wink and raised claw say it.
- **The cheer's sparkles** stand a breath of sky off his claws, never flush (`✶▗▟▛███▛█▄ ✻`): the ✻
  a cell out from his right claw, which fills its cell, and the ✶ beside his left, whose quadrant
  leaves half a cell. With no room on his left, both go on his right a cell apart, else the ✻ alone.
  Apple's Clawd ends in quadrants, so his stand a cell out each side, or at his claws if no room.
- **The cheer's step out** (`stepOut`). Cheering from home, he steps a cell out so the ✶ has sky
  all around. By the band's edge (no shell) every cheer does, still and in Apple's Terminal too, the
  step riding on the pose change as his arms go up, and `reach` lets him stand there with the tide
  in. By the shell only the lively spin carries him out, where the ✻ keeps its cell of air. Lively,
  once settled, he pads home with one step (in idle, or when the tide has come up to his cell) on a
  tick no wave washes up to his feet (`isLapAtFeet`). Still, he goes home in the frame his arms come
  down or a pet takes over, and out again if the finale comes back after the pet, so he never moves
  a cell on a tick where nothing else about him changes.

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
| Idle | A blink every 19 to 31 s, a lap every 25 to 36 s, a 3 s look out to sea every 45 to 75 s, a short scuttle every 60 to 100 s. | A loop of about 27 s; the alt says "Clawd strolls on the sand". |
| At work | He potters every 10 to 18 s. "Editing register.tsx · 3 of 7 done". | A reading loop until the turn changes something, then a work loop. |
| Turn finished | The 13-frame spin, then arms up with ✻ and ✶, 5 s in all. "✻ Done in 41s · 7 tools · 2 files changed" (the tools leave out todo bookkeeping), clay and green while he cheers. A turn that lands mid-splash has its cheer within a tick, his pose and "Done", while the sea ebbs on from where the wave had it (`isSplashShown`). | The same in pixels; the sparkles pop and shrink, never fading. A turn that lands mid-splash replaces the splash's frame with the cheer's. |
| Stopped, or an error | No spin. "Stopped after 12s" (dim), or "Stopped on an error after 12s". | No cheer; the same words. |
| A tool failed | Eyes shut, arms up, the water rushing to his feet with spray, then sliding back. 'Splash! "Run the tests" failed' for 3 s, then the same in dim. | The sea surges to his feet and back over 2.4 s. Four drops swell out of the crest, leap and shrink away at full color, never fading, all back in the sea by 2.2 s (`DROPS_END_S`). Each failure is a new frame (`data-wave`); one in the first 1.25 s of the same turn rides along. |
| High tide | He backs up to the water's edge, and the water runs under his feet now and then. One toast. | The sea comes right up to him. |
| Nap (3 quiet minutes) | He walks home and curls up by the shell, a z rising. "Napping · last turn took 41s". | He walks home, curls up, then "z Z Z". One source for the whole nap. |
| Petted | A click: arms up and a wink, the heart 2 s. Asleep, he stays curled. During a cheer, the cheer still ends when it would have, and its arms-up finale keeps what the pet leaves only with a second or more to go (`finaleAt`, `FINALE_LEAST`); with less, he ends the cheer facing you at rest. | A pointer resting on the beach: a pixel heart beside him that walks with him and beats softly; over his head as he sleeps. |
| Still | Nothing moves on its own: a cheer is one held pose, a nap is curled at once, a splash is its peak frame. By the band's edge a pet during the cheer takes him home on the pet's own pose change. | No keyframes; reduced motion puts every animation under `prefers-reduced-motion: no-preference`. The frame holds him where the last one had him (`stillDx`). The alts say "Clawd stands on the sand" idle and "A wave splashes over Clawd's feet" for the held splash. |

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
"Splash!", "86%"). A resize is taken up on the very frame that shows it (`place()`): he keeps his
place relative to home (a cheer steps out from the new one), never stands over the shell, and a
sleeper stays curled. In Apple's Terminal the beach draws Claude Code's simpler Clawd, with no arms
and no spin.

### What shows where

- **Line 1, what is happening:** the running tool or current todo, with the tally; after a turn, its
  time, tools and changed files, or "Stopped after 12s"; a failed tool, verdict first; "Next up:
  Write the tests", then "Next: Write the tests…", never cut to one word (without room for two, the
  turn's own line stays); the nap. No spinner, since Claude Code's own sits right above. The words
  are the hearth's for the same facts, so a switch changes the picture, not the vocabulary.
- **Line 2, the tide:** the percent, the `/compact` nudge when high, the cost (none until a cent is
  spent), and the limit (`limitShown`: the 5-hour one, unless another is at 80% or more and closer
  to running out), named "5h", "7d" or "spend". Past half, its reset as a time of day ("resets
  4:57am"), which never goes stale. Before any reading: "No context reading yet".
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

What failed is named as the hearth names it: a quote in its working line's verb ('"Read
docs.example.com" failed'), then a word for the kind of step (`nounOf`): "A command", "A subagent",
"A skill", "A web search", "A task", a set phrase ("Finding tools failed"), or for a tool at a name
what it did to what (`NAME_NOUNS`: "A search", "A file read", "A file edit", "A file write", "A
page", "A listing"); then "A tool", left out under a word as short ("A task", "A page"). Another
server's tool is quoted with its server whole, then named in words, never as an order nobody gave
("A GitHub tool failed", "An Asana tool failed": `article`).

### Terminal and desktop

On the terminal, `hooks/tide/band.tsx` is the beach's `Client` module: exactly three rows, none
padded, built from block elements, ASCII `z`, ✻ ✶ · and the ellipsis. Clawd uses the theme keys
`clawd_body` and `clawd_background`; the beach colors are accents no theme key covers.

On the desktop, `hooks/tide/desk.tsx` draws an `Svg` diorama beside Box and Text words, with Clawd
converted quadrant by quadrant from the terminal's sprites. The frame is 64 px tall at every width,
its 54 px scene 5 px from the top, in a whole-pixel view (`viewBox="0 -5 192 64"`) at `scale(3)`.
Below 48 columns the diorama narrows to `40 + 2 × (columns − 36)` units of 3 px, between 120 and
192 px. The words use the terminal's chains measured in pixels (`PIXELS`), with the room from
`bodyColumns` less the diorama and three cells of slack (`deskRoom`).

The `Svg` restarts every animation whenever its source changes, so the source is built only from
slow state, a `Scene`: the mood, the tide in 5% steps, still or not, a moment while it plays, where
he stands as it opens (`from`), the width, and for a splash which failure it is (`wave`). The alt
text comes from the Scene too: what is drawn ("Clawd strolls on the sand", "Clawd stands on the
sand" when still), then the tide in words, never a number.

- A turn changes loop at most once, from reading to work. The tide holds through a turn at
  `turnPercent`, moving in 15-point strides, and holds still while a moment plays. No times go in.
- **Every new frame starts him where the last had him.** The hooks module remembers the last scene
  (`sceneMemory()`); `positionAt` reads his place in it, and the new frame opens with a lead
  (`leadOf`): the moment plays where he stands, then he scuttles to where the loop begins. A stride
  while he potters carries the loop's phase (`carriedPhase`). A still frame draws its one pose where
  he stood, inside the sand the tide leaves (`stillDx`), except up from a nap, where it stands him
  at his loop's start, as the walk home would, so the curl never moves his still home.
- **The sea carries on.** Each Scene carries its sea outside the source's key, which `seaAfter`
  writes as negative animation delays; a rising tide waits for his walk back (`glideWait`).
- **A splash's frame goes on into the work**, so a turn that lands after a failure loads one frame.
- **The kept scene** goes to `$.state` from a `$.clock.after(0)` (a render cannot write), so a fresh
  activation keeps the frame on screen; the hearth clears it (`scene.forget()`). Several desktops
  keep one memory per width (`desktopScenes()`), and only the widest writes the kept copy.
- **Petting is a second picture:** the heart (`petHeart`) is its own image, the diorama's size,
  always mounted but parked below the band, and moved over it by the band's own hover. It carries
  his walk's keyframes and delays, so on the page's one clock it walks his walk step for step; in a
  cheer it stands up and right, clear of the sparkle by his claw, and from a nap's walk home it is
  handed over to its place over him.

## The hearth (opt-out)

Claude Code's own Clawd sits on the left. He blinks, looks over at what Claude reads, taps a claw
while Claude edits and steps in place while a command runs; he raises his arms when a turn lands,
sweats when the context runs high, naps when you are away, and spins around with a heart when petted.

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
  then the cost, then the 5h figure. The context figure always stays. Before any reading the meter
  is its empty track and the figure an en dash, `context ━━━━━━━━━━━━━━━━ –` (or `context –` once
  the meters have gone), never "0%". The track keeps the line's shape, so the first reading fills
  the meter in place and nothing after it moves; the desktop draws the same empty pill, read out as
  "No context reading yet".
- **Line 3:** the tally (`3/7 done` when short) shows only beside the words whole and goes before
  they lose anything, so a todo beside it is never cut (`uncut`). "Next up: Write the tests" is cut
  after two words at least ("Next up: Write the tests…"), never to one word and an ellipsis. Each
  message has shorter forms: "Thinking it over", "Thinking"; "Done in 2m 14s · 7 tools · 2 files
  changed" down to "Done"; "Stopped on an error after 12s", "Error after 12s", "Error".

On the desktop, Clawd is a 96 × 64 px `Svg` drawn from his pixel form and animated by CSS alone,
beside three Box/Text lines, with the meters as rounded Svg pills. The words sit in a panel of
`columns - 14` cells, at most the terminal's panel (`panelMost`: 68 at 100 columns, up to 80);
under 16 cells (30 columns) Clawd has the band alone, and a band the host gives no width gets a
100-column panel. Forms are measured at the widest of Inter, DejaVu Sans and Liberation Sans,
against the panel as a page with 7.2 px cells would lay it out, so a line keeps a cell or more to
spare; a name that must be cut is cut with an ellipsis (`cutToFit`). The alt text is a full
sentence: "Clawd rests.", "Clawd taps along as Claude works.", or when still "Clawd sits quietly
while Claude works."

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
| Past `warnAt` | a blue bead slides down, every 8 s at work, 16 s idle | a blue drop; it waits 400 ms while Claude works | Getting full · /compact when you're ready |
| Near a limit | | | Near the 5h limit · resets 4:57am ("At", "Over" past it) |
| Idle 3 minutes | eyes closed, a dim z drifts up | eyes close 3 minutes after the Svg appears, a slate z | unchanged |
| Petted | turns all the way around, winks with arms up and a pixel heart | a pointer on him: the pixel heart beside him, beating softly; asleep, over his head, moving there the moment he dozes off by himself, clear of his z | unchanged |

A nap changes Clawd and not line 3, which keeps the last turn's line, the next todo, or before the
first turn "Ready when you are". The hearth's words are its readout and Clawd carries the mood, so
what the last turn did is still there when you come back, and a prompt makes good on "Ready when you
are" at once, opening his eyes on the frame that says "Thinking it over". The beach says "Napping"
because its words tell the scene.

A hiccup too narrow for its words never cuts a set phrase: it says what kind of step it was
(`hiccupNouns`): "Hiccup · A command" (or a task, a subagent, a skill, a web search), or, for a tool
at a name, what the name is ("A file", "A search", "A page", "A folder"); then "Hiccup · A tool"
(but not after "A task", just as short), and "Hiccup" alone only on a band too narrow for any word.
On the terminal his pose and line 3 move together, so the held line goes up on a tick, or between
ticks once the frame has been up a whole tick (`Between`, from `isSettled`); a landing turn and a
turn's start show at once. A turn that lands mid-flinch ends the flinch as his cheer starts, as the
beach's cheer ends its splash, so his arms go up on the frame "Done" comes in on; a glance or flinch
he began less than a tick before keeps that tick first (`canLand`). The desktop's Svg is built from
slow state alone (one `work` mode for every tool, plus the cheer, hello, flinch, bead and calm), so
a tool starting or finishing hands the page the same Svg. The bead comes only in a quiet stretch,
never beside a raised claw, blink or glance, in the theme's blue (`ide`). Calm is one pose per
moment: he still cheers, flinches and naps, without blinks, taps or hops.

## Key decisions and why

- **The desktop draws an Svg Clawd beside flex Box and Text, never a block-character `Client`.** The
  desktop draws Box as a flex div and Text as a span in a proportional font, so block-character art
  shreds and spaces cannot align words; the words are laid out with flex, measured in pixels. The
  terminal keeps a `Client` per look, which owns its frame clock and draws exact cells.
- **The desktop draws Clawd as an image, not an interactive frame.** An `isInteractive` Svg is a
  sandboxed frame that blanks for a frame or two (50 to 100 ms on the Mac app) each time its source
  changes, and the band changes it with every moment; an image swaps cleanly and still plays its CSS.
  An image takes no `:hover`, so the pet is a heart picture the band's own Box hover moves onto him:
  no wink, no raised arms, no pause in his walk, which the frame used to give.
- **The heart is parked, not revealed.** It sits in an always-shown absolute Box where nothing of it
  shows, and the band's hover moves it over him. Measured in the Mac app: an absolute Box that is
  itself revealed (`display: none` to `flex`) is drawn as a floating card with its own fill and
  border above the band; any revealed picture starts its clock over, so a beach heart fell out of
  step with his walk; and a heart parked above or to the side fell out of step too. The hearth's
  parks wholly below the band (`top: PARKED`, `hover: { top: 0 }`). A Box parked there is squeezed
  to a pixel, and the beach's heart, which walks, then landed its first frame up to 15 px off one
  pet in three; so the beach's parks 3 rows down (`HEART_PARKED`), still across the band's bottom
  edge, which only clips it, and the hover lifts it a row above the top (`HEART_SHOWN`). Its picture
  carries a row of empty sky (`ROW_PX`, 19 px) above the heart, which keeps it under the edge while
  parked and cancels the lifted row when shown. Both held step through a whole turn, with no card,
  no blank frame and, for the beach, no first-frame jump in 8 pets of 8. Its `alt` is never empty
  (`HEART_ALT`): the Mac app draws no Svg whose alt is empty, so a heart with an empty alt never
  showed, and it was missing from the accessibility tree too.
- **The hooks module holds the words, not the surfaces.** The desktop has no frame clock to hold a
  step by itself, and the terminal drawing the same held step is what makes both name the same tools.
  The todos shown beside a step are held there too, so one hold serves all four views.
- **One set of facts, a view per look, separate modules.** `tideInfo()` and `hearthInfo()` are the
  seam, and the `Client` keys differ (`band`, `hearth`), so a switch never hands over surface state.
- **`/config` is the look's one home, and the store holds only the motion,** so a reload never finds
  two looks that disagree. `/band` is not marked `immediate`, which would let a switch reload the
  plugin mid-turn.
- **One warm color for one warning.** The theme's amber next to the clay nudge read as two alarms.
- **Bold never sits beside dim.** Ink closes both with one code, so a dim separator after bold text
  came out bold.
- **The looks write the figure differently on purpose:** on the beach the percent is what the tide
  stands for ("42% context"); on the hearth "context" labels a meter ("context 42%").
- **A moment's source is not kept past its end**, except the hello's, whose key is the idle loop's:
  a remount within the keep would play the moment again.
- **Terminal colors sit on or beside xterm's 256-color cube.** Without truecolor (tmux without its
  RGB flag, Apple's Terminal, many SSH sessions) Claude Code sends 256-color codes, rounding each
  channel evenly across the cube's six levels (chalk's way), and tmux rounds to the nearest level, so
  a color between levels can come out a different hue: a sand of `#D9B482` shows as a greenish khaki,
  and ripples of `#5888AE` as a gray teal lighter than the sea. So each terminal color rounds to the
  same entry both ways, within 0.06 in OKLab (the ripples set that bound; the rest sit within 0.035)
  and 12 degrees of hue, and no two of the looks' own colors share an entry; a test films every
  color both looks draw, through a pet, a splash, a cheer and high tide, and holds them to that. The
  cube has no tan between the sand's 180 and 137, nor a blue between the sea's 67 and 24, so the damp
  strip and the ripples are darker than a free choice would make them, in truecolor too. Clawd and
  the words use theme keys, which are the host's to round (see "Known gaps").
- **The hearth's Svg classes start with `hh-`** only in case a host ever draws it inline: both
  looks' Svgs draw as images, whose classes never meet the page's. A prefix on the tide's would
  change every tide source for no gain.

## Known gaps

- **Live reload is verified on the module side only.** The suite runs real new activations seeded
  with the last `$.state`, but cannot check whether Claude Code runs `session.start` again on an
  options-only reload, keeps `/band` registered, or lets the `/band` reply survive a reload.
- **Desktop widths are estimates.** A host that drew a 2-cell margin at 7.8 px beside 7.2 px columns
  would push two tide lines a pixel over; a font wider than the three measured would end a line in
  the page's ellipsis.
- **A fifth change in a second.** A look switch's first frame cannot wait (the old module is gone),
  so a switch just after the beach's spin changed on three ticks is a fifth change, as are two
  resizes in one second.
- **The cheer by the shell with the tide partway in** (56 to 95 columns): stepping out would leave
  the ✻ no sky, so he cheers at home and the ✶ sits a corner off the shell.
- **Below 34 columns the looks fall back differently**, and under 16 neither Clawd fits whole.
- **Two word fitters.** Both only take away and are tested at 34 to 160 columns, but a fix to one
  does not reach the other.
- **Turn-start order.** If the host ever said it was working before the prompt hook ran, the beach
  could draw one frame from the last turn's facts.
- **The hearth's desktop greeting reloads at 5 s** to drop the wave. Keeping the waving source would
  let a remount within the minute wave again.
- **The kept desktop scene lands a moment after its frame**, so a reload in that instant opens from
  the scene before.
- **Strides wait.** While Claude works, the tide's stride and the hearth's bead reach the picture
  0.4 s after the reading, and a rising tide waits for his walk back.
- **Esc with no word of it.** A host that marked neither the dispatch nor the result would show a
  splash or hiccup for under a second; an Esc whose turn ends over a second later keeps its splash.
- **The lively hearth's petted turn holds its first frame 500 ms**, since a pet shows between ticks
  and every frame stays a tick. The beach's spin does the same.
- **A screen reader can find the parked heart.** It is always mounted and its alt cannot be empty
  (see "The heart is parked, not revealed"), so it may be read out while nothing of it shows; its
  alt says what petting brings.
- **The beach heart's sky is one row of the Mac app's text.** `ROW_PX` is 19 px, a row at the app's
  font; a host whose rows were taller or shorter would land the shown heart that many pixels off.
- **The desktop heart shows at once.** The band's hover has no delay, so a pointer crossing the
  picture on its way to the prompt flashes the heart. It has no pop to play on show, only its soft
  beat. The hover never reaches the plugin.
- **The narrowest nudge** at 36 to 41 desktop columns (38 and 39 on the terminal) is "86% try
  /compact", without its dot.
- **`/config`'s quoted reason** brings down the capital of a one-word name it opens on ("Okta").
- **The water's glide is kept to a twentieth of a unit**, so a second failure in a splash's rush can
  open up to 0.2 px from where the last frame stood.
- **A wait on you:** whether the band shows beside Claude Code's own question is up to the host.
- **Ambiguous-width glyphs on the hearth:** its meters (`━`) and the en dash before the first
  reading would shift line 2 on a terminal that draws them wide.
- **Theme colors are rounded by the host.** Clawd, the words and the hearth's meters use Claude
  Code's theme keys, which a 256-color terminal shows as the host rounds them, as it does its own
  Clawd. Under chalk's rounding Clawd's clay shows as pink `#d78787`, entry 174, which the shell's
  two thin ridges share a cell or more from him, and under tmux's the light theme's green for "Done"
  comes out gray.
- **Claude Code's reload note.** A look switch through `/band` reloads the plugin's options, and the
  host prints its own two-line "options changed" note, naming the hooks it reloaded, above the
  reply (seen with a `--plugin-dir` plugin). It is the host's line, and the band cannot quiet it.
- **Claude Code's `[-]` at the right of row 1.** The host draws a dim `[-]` control at the right end
  of the band's first row, in both looks and at every width. It sits outside `bodyColumns`, and both
  looks lay out within `bodyColumns` alone, so the band never needs those cells.
- **A glob's last part is one extension**, so `**/*.failing-fixture.ts` gives way to "Splash! A
  search failed" and "Hiccup · A search" rather than being cut inside it.
- **Two short rungs of the beach's failure ladder:** Glob and Grep say "Splash! A tool failed" at 47
  and 48 terminal columns, and NotebookEdit at 47 to 51, before their own noun fits.
- **A desktop band mounted afresh mid-moment plays the moment again** from its first beat (the host
  hid and showed it), while the words keep the facts' time. A remount says nothing the module can
  see, and putting the elapsed time in the source would reload the frame at every redraw.
- **A tool soon after the prompt reloads the beach's desktop frame twice**: the thinking frame, then
  the work frame 300 ms later. Holding the first would show him watching the words beside a step.
- **Idle keeps "Done in 40s" where the next todo has no room for two words**, as for "Next: Fix the
  splash" below 46 terminal columns.
- **The holds' own waits.** A todo ticked off while "Planning" is up waits for the step after it,
  and one with nothing on its way shows half a second late. A read that starts during the tick the
  quiet line after a lone splash is up comes up to 240 ms behind the desktop, with its whole second.

## Files

- `.claude-plugin/plugin.json`: the manifest, with the `look` and `warnAt` fields. It has no
  `version`; keep the marketplace entry's description in step with it.
- `tsconfig.json`: extends `.claude-plugin/types/tsconfig.json`, which the engine lays down.
- `types/index.d.ts`: the shared facts (`Info`), the held lines (`Held`, `DeskShown`, with
  `TodosShown`), `Look`, `Motion`, `LookPick`, `KeptScene`.
- `hooks/hooks.json` names `hooks/register.tsx`: every hook, the timers, the kept scene, the render.
- `hooks/facts.ts`: the facts' pure rules: `whole()`, `describe()`, `runningAfter`, the holds and
  the todos held beside them (`tallied`, `shownTodos`), `TODO_TOOLS`, `isNewWave`, and the failure
  nouns (`nounOf`, `NAME_NOUNS`, `nounsFor`).
- `hooks/look.ts`: the look and `/band`: `parseBand`, `lookNow`, `migrateMotion`, `replyFor`,
  `offReply`, `troubleReply`, the toasts, and `REPLY_MOST`, the most a reply may hold.
- `hooks/clawd.ts`: Clawd's terminal cells, the shared palette (with `TERMINAL_HEART`, the heart
  both terminal looks draw), the desktop hearts' `pixelHeart`, `cells()`, `textPx()` and the
  desktops' `CELL_PX`, the terminal bands' `dice`, and the cuts.
- `hooks/pace.ts`: the terminal modules' one pace.
- `hooks/tide/band.tsx`: the beach's terminal module.
- `hooks/tide/desk.tsx`: the beach's desktop diorama, the Scene and its alt text, and where its
  heart parks (`HEART_PARKED`, `HEART_SHOWN`, `ROW_PX`).
- `hooks/tide/props.ts`: the beach's props, `sceneMemory()` and `desktopScenes()`.
- `hooks/tide/words.ts`: each beach line's forms, and `article` ("A" or "An" before a server).
- `hooks/tide/fit.ts`: `fitLine` and the `CELLS` and `PIXELS` measures.
- `hooks/tide/view.ts`, `hooks/tide/types.ts`: `tideInfo()` and the beach's types.
- `hooks/hearth/band.tsx`, `desk.tsx`, `props.ts`: the hearth's terminal module, its desktop Clawd,
  pills, pixel budget and heart's parking spot (`PARKED`), and its props.
- `hooks/hearth/words.ts`: each hearth line's forms, its cuts (private to the file), `uncut` and
  `hiccupNouns`, for both surfaces.
- `hooks/hearth/view.ts`, `hooks/hearth/types.ts`: `hearthInfo()` and the hearth's types.

## Tests

- `tests/band.test.ts`: the band as a whole: looks, `/config` and `/band` with every reply, the
  motion and the store, the migration, switches and reloads (fresh activations seeded with the last
  `$.state`), older state, the shared facts and holds, `describe()` and the cuts, git, `/clear`,
  Esc, the terminal pace filmed to the 10 ms while a pet, a prompt or a switch lands, each failing
  tool's words on both ladders, the todos' hold by each way a line can be on its way, the tools a
  turn ran, "Next:" never cut to one word, a switch back to the beach or `/band lively` at any
  point of a splash or a still cheer, the first frame while git is slow at every width (and git's
  answer after a start that failed partway, or one a turn's answer overtook), `/band off` by what is
  on, and every terminal color against its 256-color rounding, with every other color a theme key.
- `tests/tide.test.ts`: the beach on both surfaces: the scene and its marks at every width from 34
  to 160, every moment, still and reduced motion, the calm budgets, the narrow words and splash
  ladder, and the desktop's source rules, read through `seekDesk`, which seeks his pose and place in
  the Svg's CSS (and the hover heart's walk against his); films of a pet at every 250 ms of a cheer,
  the sparkles at every width from 34 to 60 at six tides, the one heart, the step home, a turn
  landing mid-splash, and his feet never on damp sand.
- `tests/hearth.test.ts`: the hearth on both surfaces (each test runs with `look: hearth`): every
  line at every width from 34 to 160 in cells and pixels (a todo beside its tally never cut), every
  moment, the bead, calm, petting and the `hh-` classes.

UI tests loop over the terminal and the desktop; slow sweeps and films set their own `timeoutMs`.
From the repository root:

```
claude plugin validate plugins/session-band
claude plugin test plugins/session-band
```

`validate` warns that `plugin.json` has no `version`, and passes. To type-check, load the plugin
once with `claude --plugin-dir plugins/session-band` so the engine lays down
`.claude-plugin/types/`, then run `npx tsc --noEmit -p plugins/session-band`.
