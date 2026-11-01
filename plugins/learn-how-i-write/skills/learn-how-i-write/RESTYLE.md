# Restyle a piece

The job: a target piece says what it should but doesn't sound like the user. Rewrite it so it does, and change nothing it says. The voice comes from a reference (a saved my-writing-style profile, or writing they handed you for this piece); the content comes only from the target.

This works for any surface: a paper that should sound like another paper they wrote, a cover letter that should sound like their emails, a post that should sound like their blog. What changes between surfaces is which measures matter, not the steps.

## The content contract

Before you touch a sentence, know what may not move. In the rewrite, these stay exactly as they are:

- **Claims, and how strongly each is made.** "The data suggest" doesn't become "the data show" because the user's voice is more direct. Hedges that carry evidence (the result is preliminary, the sample is small, the effect held only in one group) stay. Hedges that are only habit ("it could perhaps be argued that") are voice and may go. When you can't tell which a hedge is, keep it and list it as a flag.
- **Numbers and units**, statistics and their reporting (p-values, intervals, sample sizes), dates.
- **Citations**, in place and in shape unless the user's style guide says otherwise and they asked for it, and the reference list, untouched.
- **Quotations**, word for word, and who they're attributed to.
- **Defined terms, technical vocabulary, names of methods, variables, equations, code, tables, and figure and table labels.** If the target defines a term, the rewrite uses that term every time it did.
- **The order of the argument**: the sections and the sequence of claims within them. Paragraphs may be split or joined, and sentences reordered inside a paragraph, when that's how the user builds a paragraph; a claim never moves to another section, and nothing is added or cut, unless they ask.
- **Length**, within about 15% either way, unless their voice is markedly terser or fuller than the target's; then say how much it changed and why.

Never add a claim, an example, a source or a transition that asserts something new. Never strip an attribution. Restyling someone else's text into the user's voice doesn't make it theirs: authorship and credit stay as the target had them.

## 1. Get the voice

- **References handed over for this piece**: learn from them first (METHOD.md, through Step 4), even when a profile is saved; for this piece they outrank it. If the user only wants this one piece, the profile needn't be saved: say it's a first pass and offer the save afterwards.
- **A saved profile**: read its `SKILL.md` whole, and use its section for the target's surface plus the overall voice and the dos and don'ts.
- **A saved profile with no section for this surface**: say so, and ask for one or two pieces they wrote of this kind. Without them, work from the overall voice and the nearest surface, and say in the hand-back that it's an approximation.

Pick the tone too: who the target is for (reviewers, a class, a hiring manager, a client) decides which tone shift in the profile applies.

## 2. Measure the target the same way

Turn the target into plain text as METHOD.md's "Turning files into text" says, in a private scratch directory outside any repo. Keep the original file untouched.

When references were analyzed in this session, their `analysis.json` is still in `$WORK`. Slice the target the same way the reference was sliced, into a folder named for the same surface, and run the script on it:

```bash
cd "$WORK" && mkdir -p target/samples/paper   # same surface name as the reference
# write the target's slices into target/samples/paper/ as METHOD.md's Step 2 says
python3 stylometry.py target/samples --out target.json --exemplars target-exemplars.md
python3 stylometry.py --compare analysis.json target.json --ref-register paper --target-register paper
```

`--compare` prints every measure side by side and marks the ones that differ by more than a third. When the voice comes from a saved profile and no references were analyzed, there's no `analysis.json`: read the target against the profile's lines instead, and measure the target alone to put numbers on what you see.

## 3. Turn the differences into a plan

From the marked measures, the exemplars, the profile and a read of the target, write down the five to ten differences that most make the target not sound like the user, biggest first, each as something a writer can act on:

- "Target's sentences run 28–40 words; theirs mostly 14–24, with a short one to land a point."
- "Target opens most paragraphs with a connector (Moreover, Additionally); they open with the claim."
- "Target is passive throughout; they write 'we' and active verbs."
- "Target hedges twice per sentence; they hedge once, where the evidence is thin."
- "Target cites in brackets at sentence ends; they name authors in the sentence."
- "Target closes by restating the introduction; they close on what follows from the result."

Leave alone what already matches. A number that differs isn't a reason to change something the user would write that way anyway.

Then check the target's AI-isms against the profile's don'ts and add the ones it uses.

## 4. Rewrite

Work section by section, in order, on a copy. For each section:

- Apply the plan's differences, the dos and don'ts, and the surface's mechanics.
- Keep every item the content contract names. When a sentence can't take the user's shape without changing what it says, keep its meaning and let the shape go.
- Read the section against two or three of the reference's exemplars of the same surface: does it sound like the same person wrote both?

Don't push a measure to the reference's number for its own sake. The goal is the user's voice, and that's many small things, not one knob.

## 5. Check

- **Fidelity, mechanically.** Save the rewrite as plain text and run:

  ```bash
  python3 stylometry.py --fidelity original.txt rewrite.txt
  ```

  It lists numbers, citations (author-year, numeric, LaTeX `\cite`), quotations, links and equations that went missing or appeared, and acronyms that changed. Every strict change must be fixed, or, when it's a deliberate and harmless change (a number spelled out as the user's style guide asks), named in the hand-back. Acronym changes are checked by hand.
- **Fidelity, by reading.** The script can't see a claim strengthened or a qualifier dropped. Read the original and the rewrite side by side, paragraph by paragraph, for exactly that, and for anything added.
- **Voice.** Slice and measure the rewrite as you did the target, and `--compare` it with the reference: the marked measures should be fewer and closer. Where one still differs on purpose (a claim that needs its long sentence), leave it.

## 6. Hand back

- Write the rewrite as a new file next to the original, in the original's format where you can (pandoc writes `.docx` and `.odt`; for a `.pdf` hand back `.docx` or `.md` and say so), named like `<original name> (restyled).<ext>`. Never overwrite the original unless they ask.
- With it, a short note: the three to five biggest changes in voice, in plain words; the word count before and after; and every flag (a hedge you kept but weren't sure of, a sentence you left long, anything the fidelity check named that you didn't change and why).
- Ask how it reads. What they say is feedback on the profile: offer to fold it in, as SKILL.md's step 6 says.
- Delete the scratch directory, with the reference's analysis if it's still there.
