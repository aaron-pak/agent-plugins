# Upstream

`skills/learn-how-i-write/` starts from the `learn-how-i-write` skill in Claude Duet's default skills plugin, version 0.8.63: `SKILL.md`, `METHOD.md` and `scripts/stylometry.py`. This repository doesn't keep the verbatim copy in its history; the list below names every change from it.

Claude Duet runs the skill inside its own app: a main chat asks for a go-ahead, hands the reading to a thread session, and puts the profile on a card the user saves to claude.ai. None of that exists in Claude Code, Codex or Cursor, and Duet's skill reads only connected mail, Slack and Drive. This plugin is meant to learn from anything the user points at, papers included, and to apply the voice to another piece.

## SKILL.md

Rewritten around two jobs, learn and restyle, keeping the original's flow (go-ahead, run the method, check the result, ready message with highlights, fixes, relearn, delete) and its rules on consent, highlights and content.

- Sources: files of any common format, pasted text and links are read on being handed over; connected apps keep Duet's one-question go-ahead, accounts named, and a scheduled or headless run reads none.
- Removed everything tied to Duet's app: `propose_skills` and the card, thread sessions and `context_message_ids`, chips and tapbacks, the app's own tools, server notes (shown, declined, saved, dismissed), memory lines (Promised, card sent, Writing fix and the rest), the "Write in my style" setting, texting, and step 8 (a morning brief's first pass).
- The thread session becomes an optional subagent, and the card becomes showing the profile in the conversation and writing `my-writing-style/SKILL.md` to the harness's personal skills folder on the user's yes.
- Added: the reference vs. target distinction, whose writing may serve as a reference, one profile with a section per surface (so a paper voice and an email voice sit side by side), adding a surface as an update, and step 5, restyle, which points to the new `RESTYLE.md`.

## METHOD.md

Kept: the voice, tone and surface thesis, the guardrails, the five steps, sample handling and naming, connector discipline, the stylometry run, the thin-corpus rules, the profile's shape, the `my-writing-style` template, the highlights and the reply form.

- Step 1 checks the named sources rather than a Duet brief, drops the brief and "Write in my style" failures, and keeps the rule that a run nobody started by hand reads no connected app.
- Step 2 adds `paper/` and `post/` surfaces (open-ended, not a fixed list), audience tags for long-form (`academic`, `general`), converting files to text with tools already installed, cleaning PDFs and LaTeX, slicing long pieces into consecutive samples across the whole piece rather than one opening slice (near 500 words when a surface has only one or two pieces, so one paper of about 3,000 words is enough), and an outline per long piece in `structure/`. The scratch directory honours `$TMPDIR`, and the rules about hiding paths from the user are gone.
- Step 3 describes the new long-form measures, and a script that can't run means reading without statistics instead of a failure.
- Step 4 adds long-form headings for each long-form surface (structure, paragraphs, sentences, stance, evidence and citations, vocabulary, mechanics), academic AI-isms in the don'ts, and numbers turned into actionable ranges. In the template, the description and first line cover restyling and papers, "Applying this profile" gains a content-fidelity step and a fallback for a surface with no section, and "Updating this profile" offers the change and saves it on the user's yes by editing the file in place, instead of Duet's `save_writing_style` and `save_skill` tools; it keeps the clean-up of a leftover working folder.
- Step 5 allows about a page and a half, adds a `[surface]` highlight tag, and drops the 32 KB and `review` notes.
- The guardrails are kept, with "Consent first" reworded for handed-over sources.

## RESTYLE.md

New: the content contract, then measure (in its own scratch directory, re-measuring the reference beside the target; skipped for short pieces), compare, plan, rewrite, check and hand back, with what a Word round trip loses.

## scripts/stylometry.py

- Abbreviations ("et al.", "e.g.", "Fig.") no longer end a sentence.
- A `longform` block for every non-chat register: paragraph shape, sentence-length spread, word length, vocabulary variety (MATTR), nominalizations, hedges, boosters, first and second person, approximate passive voice, sentence-initial connectors and first words, citation shapes and quotation rate.
- `--compare REFERENCE.json TARGET.json` prints the two analyses side by side and marks the measures that differ by more than a third.
- `--fidelity ORIGINAL REWRITE` lists numbers (".03" included), citations (including LaTeX `\cite`), quotations, links, equations, LaTeX cross-references and acronyms a rewrite dropped or added, and exits 1 on any strict change.
- `--selftest` covers all of the above, and the docstring describes the new modes.
