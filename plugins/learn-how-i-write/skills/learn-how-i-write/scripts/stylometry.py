#!/usr/bin/env python3
"""Stylometry for learn-how-i-write: filter writing samples, compute per-register
style stats, pick representative-but-diverse exemplars, compare two analyses,
and check that a restyled text kept its content.

Pure standard library — no numpy, no sklearn, no network. Input is a directory
with one subdirectory per register (email/ slack/ dm/ doc/ paper/ post/ ...),
one sample per .txt file.

Usage:
    python3 stylometry.py SAMPLES_DIR [--out analysis.json]
        [--exemplars exemplars.md] [--min-words 30] [--chat-min-words 10]
        [--per-register 5]
    python3 stylometry.py --compare REFERENCE.json TARGET.json
        [--ref-register R] [--target-register T]
    python3 stylometry.py --fidelity ORIGINAL.txt REWRITE.txt
    python3 stylometry.py --selftest

Every register gets the base stats; registers that aren't chat also get a
"longform" block (paragraph shape, hedging and stance, first person, passive
voice, sentence openers and connectors, citations, quotation, vocabulary
density), which is what papers, reports and long docs are judged on.
--compare prints the reference and the target side by side and marks the
metrics that differ most. --fidelity lists numbers, citations, quotations,
links and acronyms that a rewrite dropped or added, and exits 1 when any
number, citation, quotation, link or equation changed.

Registers named dm / internal_msg / slack* / chat* use --chat-min-words, and
pool files that share a "<bundle>__" filename prefix (the
"<channel-or-person>__<YYYY-MM-DD>__NNN.txt" convention) into one aggregate
sample — short-form voice is measured in bundles, not dropped message by
message. The length gates are part of the method: when a corpus fails them,
gather more real writing instead of lowering the thresholds.
"""

import argparse
import json
import math
import re
import statistics
import sys
import tempfile
from collections import Counter
from pathlib import Path

CHAT_REGISTERS = re.compile(r"^(dm|internal_msg|slack|chat)", re.I)

FORWARD_MARKERS = (
    "---------- forwarded message",
    "begin forwarded message",
    "-----original message-----",
)
AUTOREPLY_MARKERS = ("out of office", "automatic reply", "auto-reply", "ooo until")
# A quoted-reply tail ("On <date>, <someone> wrote:") and everything after it
# is other people's text — it must never contribute to the user's profile.
QUOTED_TAIL = re.compile(r"\n+On .{5,80}wrote:\s*\n", re.S)
# Inline reply headers and signature delimiters — also not the user's prose.
REPLY_HEADER = re.compile(r"^(from|to|cc|subject|date|sent):\s", re.I)
SIG_DELIM = re.compile(r"^(--\s*$|sent from my |get outlook for )", re.I)
# Outlook/M365 separates the quoted tail with a long run of underscores or
# dashes; treat it as a hard truncation boundary like SIG_DELIM.
OUTLOOK_SEP = re.compile(r"^\s*[_-]{8,}\s*$")

CONTRACTION = re.compile(
    r"\b\w+'(?:t|re|ve|ll|d|m)\b|"
    r"\b(?:it|that|there|he|she|what|who|let|here|where|how)'s\b",
    re.I,
)
GREETING = re.compile(r"^(hi|hey|hello|dear|good (morning|afternoon)|yo|howdy)\b", re.I)
CLOSING = re.compile(
    r"^(thanks|thank you|best|cheers|regards|talk soon|warmly|sincerely|ty|thx)\b", re.I
)
BULLET = re.compile(r"^\s*([-*•]|\d+[.)])\s+\S", re.M)
EMOJI = re.compile(
    "[\U0001f300-\U0001faff\U00002600-\U000027bf]|:[a-z_]+:|[:;]-?[)(DPp]"
)
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n{2,}")
# Abbreviations whose period isn't a sentence end ("et al. (2020)", "e.g. this").
# Their final period is masked before splitting and restored after.
ABBREV = re.compile(
    r"\b(?:e\.g|i\.e|et al|cf|vs|viz|approx|figs?|eqs?|sec|ch|vol|pp|dr|mr|mrs|prof|jr|sr)\.",
    re.I,
)
ABBREV_MASK = "\u2024"
# Unicode letters (no digits/underscore) with optional internal apostrophes —
# works for non-Latin scripts, not just ASCII.
WORD = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*")

# Function words + discourse markers whose relative rates fingerprint a voice.
FUNCTION_WORDS = (
    "the a an and but or so because though although just really actually "
    "maybe probably definitely honestly basically pretty quite very also "
    "however therefore anyway plus btw fwiw imo tbh kinda sorta gonna"
).split()

# Common AI-writing tells (vocab subset) — measured so the profile can record
# the user's OWN baseline rather than banning them outright.
AI_TELL_WORDS = (
    "delve leverage robust seamless streamline pivotal crucial crucially "
    "notably furthermore moreover additionally comprehensive holistic "
    "landscape ecosystem utilize foster empower elevate"
).split()
NOT_X_BUT_Y = re.compile(r"\bnot (?:just|only|merely)\b.{3,60}\bbut\b", re.I | re.S)

STOPWORDS = set(
    "the a an and or but if then than so to of in on at for with from by as is "
    "are was were be been being it its this that these those i you he she we "
    "they them his her my your our their me us do does did have has had will "
    "would can could should may might not no yes what which who when where how "
    "there here all any some more most other into about over after before "
    "out up down off just also very".split()
)


def tokenize(text):
    return [w.lower() for w in WORD.findall(text)]


def sentences(text):
    masked = ABBREV.sub(lambda m: m.group(0)[:-1] + ABBREV_MASK, text)
    return [
        s.strip().replace(ABBREV_MASK, ".")
        for s in SENT_SPLIT.split(masked)
        if WORD.search(s or "")
    ]


def clean_sample(raw):
    """Keep only the user's own prose: drop forwards/auto-replies entirely;
    strip quoted-reply tails, '>' quote lines, inline reply headers, and
    everything from a signature delimiter down. Third-party text must never
    reach the stats, the exemplars, or the profile."""
    # Normalize typographic punctuation so the straight-apostrophe CONTRACTION
    # pattern still sees contractions from smart-quote sources.
    raw = raw.replace("’", "'").replace("‘", "'").replace("…", "...")
    low = raw.lower()
    if any(m in low for m in FORWARD_MARKERS) or any(
        m in low[:300] for m in AUTOREPLY_MARKERS
    ):
        return None
    text = QUOTED_TAIL.split(raw)[0]
    src = text.splitlines()
    lines = []
    i = 0
    while i < len(src):
        stripped = src[i].lstrip()
        if stripped.startswith(">"):
            i += 1
            continue
        if SIG_DELIM.match(stripped) or OUTLOOK_SEP.match(stripped):
            break
        if REPLY_HEADER.match(stripped):
            # Two or more consecutive header lines after the user's own prose
            # is the Outlook/M365 quoted-tail boundary (no "wrote:" line, no
            # '>' prefix) — truncate. A lone header-looking line is skipped
            # (a user can plausibly write "To: everyone — thanks"); a header
            # block before any prose is top-of-message headers, also skipped.
            nxt = src[i + 1].lstrip() if i + 1 < len(src) else ""
            if lines and REPLY_HEADER.match(nxt):
                break
            i += 1
            continue
        lines.append(src[i])
        i += 1
    return "\n".join(lines).strip() or None


def sample_stats(text, segments=None):
    """A sample is one file, or a pooled bundle of chat messages. `segments`
    keeps the message boundaries so per-message stats (emoji, bullets,
    greetings) stay honest when a 10-message bundle counts as one sample."""
    sents = sentences(text)
    words = tokenize(text)
    segments = segments or [text]
    return {
        "text": text,
        "segments": segments,
        "n_messages": len(segments),
        "sents": sents,
        "words": words,
        "n_words": len(words),
    }


def rate(count, denom, per=1000.0):
    return round(count / denom * per, 2) if denom else 0.0


def register_stats(samples):
    """Aggregate style statistics over one register's cleaned samples."""
    all_text = "\n\n".join(s["text"] for s in samples)
    all_words = [w for s in samples for w in s["words"]]
    all_sents = [s2 for s in samples for s2 in s["sents"]]
    n_chars = len(all_text)
    n_words = len(all_words)
    sent_lens = [len(tokenize(s)) for s in all_sents] or [0]

    # Per-message stats iterate segments, not samples — a pooled bundle is one
    # sample but many messages, and dividing by samples would inflate rates.
    segs = [seg for s in samples for seg in s["segments"]]
    first_lines, last_lines = [], []
    for seg in segs:
        lines = [ln.strip() for ln in seg.splitlines() if ln.strip()]
        if lines:
            first_lines.append(lines[0])
            # Sign-offs are often "cheers," followed by the name on its own
            # line, so scan the last two lines for a closing.
            last_lines.extend(lines[-2:])

    def punct(ch):
        return rate(all_text.count(ch), n_chars)

    lower_starts = sum(1 for x in all_sents if x and x[0].islower())
    conj_starts = sum(
        1 for x in all_sents if re.match(r"(and|but|so|also)\b", x, re.I)
    )
    fw_counts = Counter(w for w in all_words if w in FUNCTION_WORDS)
    tell_counts = Counter(w for w in all_words if w in AI_TELL_WORDS)
    grams = Counter()
    for s in samples:
        toks = s["words"]
        for n in (2, 3):
            for i in range(len(toks) - n + 1):
                g = toks[i : i + n]
                if g[0] not in STOPWORDS or g[-1] not in STOPWORDS:
                    grams[" ".join(g)] += 1
    common_grams = [g for g, c in grams.most_common(200) if c >= 3][:15]

    return {
        "n_samples": len(samples),
        "n_messages": len(segs),
        "n_words": n_words,
        "words_per_sample_median": statistics.median(s["n_words"] for s in samples),
        # For pooled chat bundles the per-sample median is words per BUNDLE;
        # this one is the honest per-message length.
        "words_per_message_median": statistics.median(
            len(tokenize(seg)) for seg in segs
        ),
        "sentence_len_mean": round(statistics.mean(sent_lens), 1),
        "sentence_len_median": statistics.median(sent_lens),
        "sentence_len_stdev": round(statistics.pstdev(sent_lens), 1),
        "contractions_per_100_words": rate(
            len(CONTRACTION.findall(all_text)), n_words, 100
        ),
        "punct_per_1000_chars": {
            "!": punct("!"), "?": punct("?"), ";": punct(";"), ":": punct(":"),
            "em_dash": rate(all_text.count("—") + all_text.count(" - "), n_chars),
            "ellipsis": rate(all_text.count("..."), n_chars),
            "parens": punct("("),
        },
        "exclam_per_100_sentences": rate(all_text.count("!"), len(all_sents), 100),
        "emoji_per_message": rate(len(EMOJI.findall(all_text)), len(segs), 1),
        "pct_sentences_start_lowercase": rate(lower_starts, len(all_sents), 100),
        "pct_sentences_start_conjunction": rate(conj_starts, len(all_sents), 100),
        "pct_messages_with_bullets": rate(
            sum(1 for seg in segs if BULLET.search(seg)), len(segs), 100
        ),
        "common_greetings": [g for g, _ in Counter(
            m.group(0).lower() for ln in first_lines
            for m in [GREETING.match(ln)] if m).most_common(3)],
        "common_closings": [c for c, _ in Counter(
            m.group(0).lower() for ln in last_lines
            for m in [CLOSING.match(ln)] if m).most_common(3)],
        "function_word_rates_per_1000": {
            w: rate(c, n_words) for w, c in fw_counts.most_common(15)
        },
        "ai_tell_baseline": {
            "tell_words_per_1000": {w: rate(c, n_words) for w, c in tell_counts.items()},
            "not_x_but_y_per_100_sentences": rate(
                len(NOT_X_BUT_Y.findall(all_text)), len(all_sents), 100
            ),
            "em_dash_per_1000_chars": rate(
                all_text.count("—") + all_text.count(" - "), n_chars
            ),
        },
        "frequent_phrases": common_grams,
    }


# Long-form measures. Each is a rate, so a short reference and a long target
# compare fairly. Lists are deliberately small and English: they find habits,
# not a full taxonomy, and non-English corpora get non_english_suspected.
HEDGES = re.compile(
    r"\b(?:(?-i:may)|might|could|perhaps|possibly|probably|likely|unlikely|apparently|"
    r"arguably|seemingly|somewhat|relatively|potentially|presumably|"
    r"suggests?|suggested|indicates?|indicated|appears?|appeared|seems?|seemed|"
    r"tends? to|to some (?:extent|degree)|in part|it is possible)\b",
    re.I,
)
BOOSTERS = re.compile(
    r"\b(?:clearly|obviously|certainly|undoubtedly|definitely|indeed|of course|"
    r"surely|plainly|evidently|demonstrates?|demonstrated|proves?|proved|"
    r"must|always|without doubt|it is clear)\b",
    re.I,
)
FIRST_SING = {"i", "me", "my", "mine", "myself"}
FIRST_PLUR = {"we", "us", "our", "ours", "ourselves"}
SECOND = {"you", "your", "yours", "yourself", "yourselves"}
# "was/were/is ... + participle", allowing a couple of adverbs between. An
# approximation: regular -ed/-en/-wn participles plus the common irregular
# ones, less the -ed/-en/-wn words that are seldom participles.
IRREGULAR_PARTICIPLES = (
    "found made done given taken seen shown known held kept left told thought "
    "brought built bought caught chosen drawn driven felt heard led lost meant met "
    "paid put read run said sent set sold spent stood taught understood won written "
    "cut hit laid begun become"
)
NOT_PARTICIPLES = (
    "often even open when then seven eleven garden between children indeed need "
    "needed speed seed feed red bed hundred kindred sacred naked wicked down town "
    "own brown crown gown"
)
PASSIVE_ADVERBS = r"(?:\w+ly|also|then|first|not|already|still|further|thus|therefore|often|never|always|now|later|subsequently)"
PASSIVE = re.compile(
    r"\b(?:am|is|are|was|were|be|been|being)(?:\s+" + PASSIVE_ADVERBS + r"){0,2}\s+"
    r"(?!(?:" + "|".join(NOT_PARTICIPLES.split()) + r")\b)"
    r"(?:\w{2,}(?:ed|en|wn)|" + "|".join(IRREGULAR_PARTICIPLES.split()) + r")\b",
    re.I,
)
NOMINAL = re.compile(r"^\w{3,}(?:tion|sion|ment|ness|ity|ance|ence|ism)s?$")
CONNECTORS = (
    "however moreover furthermore additionally thus therefore hence consequently "
    "indeed notably importantly overall ultimately finally first second third "
    "similarly likewise conversely instead meanwhile nevertheless nonetheless "
    "still yet also accordingly specifically"
).split() + [
    "in addition", "in contrast", "for example", "for instance", "as a result",
    "in other words", "that said", "on the other hand", "in particular",
    "taken together", "in short", "to be sure", "at the same time",
]
CONNECTOR_START = re.compile(
    r"^(" + "|".join(sorted((re.escape(c) for c in CONNECTORS), key=len, reverse=True)) + r")\b",
    re.I,
)
# Citation shapes: (Smith, 2020), (Smith & Lee 2020; Wu et al., 2019a, p. 4),
# Smith (2020), Smith et al. (2020), [3], [3, 7], [3–5].
MONTHS = (
    "January|February|March|April|May|June|July|August|September|October|November|December|"
    "Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Spring|Summer|Fall|Autumn|Winter"
)
CITE_PAREN = re.compile(
    r"\((?:see |e\.g\.,? |cf\. )?(?!(?:" + MONTHS + r")\b)[A-Z][\w'’-]+"
    r"(?:(?:,\s*|\s+)(?:and\s+|&\s*)?[A-Z][\w'’-]+)*(?:\s+et al\.)?,?\s+\d{4}[a-z]?"
    r"(?:[^()]{0,80}?)\)"
)
CITE_NARR = re.compile(r"\b[A-Z][\w'’-]+(?:\s+(?:et al\.|and|&)\s+[A-Z][\w'’-]+|\s+et al\.)?\s+\(\d{4}[a-z]?(?:,[^()]{0,20})?\)")
CITE_NUM = re.compile(r"\[\d+(?:\s*[,–-]\s*\d+)*\]")
# An opening quote follows the start, a space or an opening bracket, and a
# closing one isn't followed by a letter, so '"1" to "7"' isn't read as the
# quotation ' to '.
QUOTE = re.compile(r"(?<![^\s(\[—])[\"“]([^\"“”\n]{3,400}?)[\"”](?!\w)")


def _pct(values, q):
    if not values:
        return 0
    vals = sorted(values)
    return vals[min(len(vals) - 1, int(round(q * (len(vals) - 1))))]


def mattr(words, window=100):
    """Moving-average type-token ratio: vocabulary variety that doesn't fall
    just because a text is longer, unlike a plain type-token ratio."""
    if not words:
        return 0.0
    if len(words) <= window:
        return round(len(set(words)) / len(words), 3)
    counts = Counter(words[:window])
    total = len(counts) / window
    for i in range(window, len(words)):
        counts[words[i]] += 1
        old = words[i - window]
        counts[old] -= 1
        if not counts[old]:
            del counts[old]
        total += len(counts) / window
    return round(total / (len(words) - window + 1), 3)


def paragraphs(text):
    return [p.strip() for p in re.split(r"\n\s*\n", text) if WORD.search(p)]


def longform_stats(samples):
    """Measures that matter most in long, considered writing: papers, essays,
    reports, docs. Computed over the register's pooled text."""
    all_text = "\n\n".join(s["text"] for s in samples)
    words = [w for s in samples for w in s["words"]]
    n_words = len(words)
    sents = [x for s in samples for x in s["sents"]]
    n_sents = len(sents)
    sent_lens = [len(tokenize(x)) for x in sents] or [0]
    paras = [p for s in samples for p in paragraphs(s["text"])]
    para_words = [len(tokenize(p)) for p in paras] or [0]
    para_sents = [len(sentences(p)) for p in paras] or [0]
    starts = Counter()
    first_words = Counter()
    for x in sents:
        m = CONNECTOR_START.match(x)
        if m:
            starts[m.group(1).lower()] += 1
        toks = tokenize(x)
        if toks:
            first_words[toks[0]] += 1
    wc = Counter(words)
    return {
        "paragraph_words_median": statistics.median(para_words),
        "paragraph_sentences_median": statistics.median(para_sents),
        "pct_one_sentence_paragraphs": rate(sum(1 for n in para_sents if n == 1), len(paras), 100),
        "sentence_len_p10": _pct(sent_lens, 0.1),
        "sentence_len_p90": _pct(sent_lens, 0.9),
        "pct_sentences_over_30_words": rate(sum(1 for n in sent_lens if n > 30), n_sents, 100),
        "pct_sentences_under_10_words": rate(sum(1 for n in sent_lens if n < 10), n_sents, 100),
        "mean_word_length": round(sum(len(w) for w in words) / n_words, 2) if n_words else 0.0,
        "vocabulary_variety_mattr": mattr(words),
        "nominalizations_per_1000_words": rate(sum(1 for w in words if NOMINAL.match(w)), n_words),
        "hedges_per_1000_words": rate(len(HEDGES.findall(all_text)), n_words),
        "boosters_per_1000_words": rate(len(BOOSTERS.findall(all_text)), n_words),
        "first_person_singular_per_1000_words": rate(sum(wc[w] for w in FIRST_SING), n_words),
        "first_person_plural_per_1000_words": rate(sum(wc[w] for w in FIRST_PLUR), n_words),
        "second_person_per_1000_words": rate(sum(wc[w] for w in SECOND), n_words),
        "passive_per_100_sentences_approx": rate(len(PASSIVE.findall(all_text)), n_sents, 100),
        "connector_starts_per_100_sentences": rate(sum(starts.values()), n_sents, 100),
        "top_sentence_connectors": {c: rate(n, n_sents, 100) for c, n in starts.most_common(8)},
        "top_sentence_first_words": {w: rate(n, n_sents, 100) for w, n in first_words.most_common(8)},
        "citations_per_1000_words": {
            "parenthetical_author_year": rate(len(CITE_PAREN.findall(all_text)), n_words),
            "narrative_author_year": rate(len(CITE_NARR.findall(all_text)), n_words),
            "numeric_brackets": rate(len(CITE_NUM.findall(all_text)), n_words),
        },
        "quotations_per_1000_words": rate(
            sum(1 for q in QUOTE.findall(all_text) if len(tokenize(q)) >= 4), n_words
        ),
    }


# --compare: which numbers to line up. Counts and identifiers are left out,
# since a reference and a target differ in size by design.
COMPARE_SKIP = re.compile(
    r"(^|\.)(n_samples|n_messages|n_words|english_stopword_fraction|non_english_suspected|"
    r"words_per_sample_median|words_per_message_median)$|(^|\.)audiences(\.|$)"
)
# Dicts that hold only each side's top few entries: a word missing from one
# side means "not in its top few", not zero, so such a row is shown but never
# marked.
TOP_N = re.compile(r"(^|\.)(function_word_rates_per_1000|top_sentence_connectors|top_sentence_first_words)\.")


def flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, key + "."))
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out[key] = v
    return out


def compare_registers(ref, tgt):
    """Rows of (metric, reference, target, marked) for two registers' stats.
    A row is marked when the two differ by more than a third of the larger
    value and by more than a small absolute floor, so rare habits at near-zero
    rates don't flood the list."""
    fr = {k: v for k, v in flatten(ref).items() if not COMPARE_SKIP.search(k)}
    ft = {k: v for k, v in flatten(tgt).items() if not COMPARE_SKIP.search(k)}
    rows = []
    for k in sorted(set(fr) | set(ft)):
        top_n = bool(TOP_N.search(k))
        if top_n and (k not in fr or k not in ft):
            rows.append((k, fr.get(k, "—"), ft.get(k, "—"), False))
            continue
        a, b = fr.get(k, 0), ft.get(k, 0)
        big = max(abs(a), abs(b))
        marked = big > 0.5 and abs(a - b) > big / 3
        rows.append((k, a, b, marked))
    return rows


def compare_main(ref_path, tgt_path, ref_reg=None, tgt_reg=None):
    ref = json.loads(Path(ref_path).read_text())["registers"]
    tgt = json.loads(Path(tgt_path).read_text())["registers"]
    if ref_reg or tgt_reg:
        pairs = [(ref_reg or next(iter(ref)), tgt_reg or next(iter(tgt)))]
    elif len(ref) == 1 and len(tgt) == 1:
        pairs = [(next(iter(ref)), next(iter(tgt)))]
    else:
        pairs = [(r, r) for r in ref if r in tgt]
    if not pairs:
        sys.exit(f"No register to compare: reference has {sorted(ref)}, target {sorted(tgt)}. Pass --ref-register and --target-register.")
    for r, t in pairs:
        if r not in ref or t not in tgt:
            sys.exit(f"Unknown register: reference has {sorted(ref)}, target {sorted(tgt)}.")
        rows = compare_registers(ref[r], tgt[t])
        marked = [x for x in rows if x[3]]
        print(f"## Reference `{r}` vs target `{t}`\n")
        print(f"{len(marked)} of {len(rows)} measures differ by more than a third (marked ◆, biggest gap first).\n")
        print("| measure | reference | target | |")
        print("|---|---|---|---|")

        def gap(row):
            a, b = row[1], row[2]
            if isinstance(a, str) or isinstance(b, str):
                return 0
            return abs(a - b) / max(abs(a), abs(b), 1e-9)

        def is_entry(row):
            # Entries of a word-by-word dict come after the single measures
            # (sentence length, passive voice...), which say more.
            return bool(TOP_N.search(row[0])) or ".tell_words_per_1000." in row[0]

        for k, a, b, m in sorted(rows, key=lambda x: (not x[3], is_entry(x), -gap(x) if x[3] else 0, x[0])):
            print(f"| {k} | {a} | {b} | {'◆' if m else ''} |")
        print()


# --fidelity: what a restyle must carry over unchanged.
FIDELITY = {
    "numbers": (re.compile(r"(?<![\w.])[-−]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)%?"), True),
    "citations": (re.compile("|".join([p.pattern for p in (CITE_PAREN, CITE_NARR, CITE_NUM)] + [r"\\\w*cite\w*\*?(?:\[[^\]]*\])*\{[^}]+\}"])), True),
    "quotations": (QUOTE, True),
    "links": (re.compile(r"https?://[^\s)>\]]+|\bdoi:\s*\S+|\b10\.\d{4,9}/[^\s)>\]]+"), True),
    # $x^2$ but not "$5 and $10": no space just inside the dollars, no digit after.
    "equations_and_code": (re.compile(r"\$(?=\S)[^$\n]+?(?<=\S)\$(?!\d)|`[^`\n]+`"), True),
    "cross_references": (re.compile(r"\\(?:eq|auto|page|c|C|name)?ref\{[^}]+\}|\\label\{[^}]+\}"), True),
    "acronyms": (re.compile(r"\b[A-Z][A-Z0-9]{1,}[a-z]?s?\b"), False),
}


def _norm(x):
    x = x.replace("−", "-").replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", x).strip().rstrip(".,;:")


def fidelity_report(original, rewrite):
    """Per category: (strict, missing Counter, added Counter)."""
    out = {}
    for name, (pat, strict) in FIDELITY.items():
        def grab(t):
            found = pat.findall(t) if pat.groups == 0 else [m.group(0) for m in pat.finditer(t)]
            vals = [_norm(v) for v in found]
            if name == "numbers":
                vals = [v.replace(",", "") for v in vals]
            return Counter(v for v in vals if v)
        a, b = grab(original), grab(rewrite)
        out[name] = (strict, a - b, b - a)
    return out


def fidelity_main(orig_path, new_path):
    original = Path(orig_path).read_text(errors="replace")
    rewrite = Path(new_path).read_text(errors="replace")
    report = fidelity_report(original, rewrite)
    failed = False
    for name, (strict, missing, added) in report.items():
        if not missing and not added:
            print(f"{name}: unchanged")
            continue
        label = "CHANGED" if strict else "changed (check by hand)"
        failed |= strict
        print(f"{name}: {label}")
        for v, n in sorted(missing.items()):
            print(f"  - missing{f' x{n}' if n > 1 else ''}: {v}")
        for v, n in sorted(added.items()):
            print(f"  + added{f' x{n}' if n > 1 else ''}: {v}")
    ow, nw = len(tokenize(original)), len(tokenize(rewrite))
    print(f"words: {ow} -> {nw} ({rate(nw - ow, ow, 100):+}%)")
    print("fidelity FAILED" if failed else "fidelity OK")
    return 1 if failed else 0


def tfidf_vectors(samples):
    docs = [[w for w in s["words"] if w not in STOPWORDS] for s in samples]
    df = Counter(w for d in docs for w in set(d))
    n = len(docs)
    vecs = []
    for d in docs:
        tf = Counter(d)
        v = {w: (1 + math.log(c)) * math.log(n / df[w]) for w, c in tf.items() if df[w] < n}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({w: x / norm for w, x in v.items()})
    return vecs


def cosine(a, b):
    if len(b) < len(a):
        a, b = b, a
    return sum(x * b.get(w, 0.0) for w, x in a.items())


def pick_exemplars(samples, k):
    """First the most central sample, then greedily the most different ones —
    representative AND diverse, so the distill step sees the voice's range."""
    if len(samples) <= k:
        return list(range(len(samples)))
    vecs = tfidf_vectors(samples)
    mean_sim = [
        sum(cosine(v, u) for u in vecs) / len(vecs) for v in vecs
    ]
    chosen = [max(range(len(vecs)), key=lambda i: mean_sim[i])]
    while len(chosen) < k:
        # Farthest-point sampling: the candidate least similar to its
        # nearest already-chosen exemplar (ties break toward central).
        best = max(
            (i for i in range(len(vecs)) if i not in chosen),
            key=lambda i: -max(cosine(vecs[i], vecs[j]) for j in chosen)
            + 1e-9 * mean_sim[i],
        )
        chosen.append(best)
    return chosen


def pick_exemplars_stratified(samples, k):
    """pick_exemplars, with one slot reserved per audience tag when a register
    carries two or more. Tone evidence needs a contrasting pair, and plain
    diversity picks by vocabulary, not audience — a minority audience can get
    zero slots. Reserved picks are each group's most central sample; the rest
    fill by the same farthest-point rule. Registers with fewer than two
    distinct tags fall through to pick_exemplars unchanged, so single-audience
    output is identical."""
    groups = {}
    for i, s in enumerate(samples):
        tag = s.get("audience")
        if tag is not None:
            groups.setdefault(tag, []).append(i)
    if len(groups) < 2 or len(samples) <= k:
        return pick_exemplars(samples, k)
    vecs = tfidf_vectors(samples)
    chosen = []
    # Largest audiences first; k can be smaller than the number of tags.
    for tag in sorted(groups, key=lambda t: (-len(groups[t]), t))[:k]:
        members = groups[tag]
        central = max(
            members,
            key=lambda i: sum(cosine(vecs[i], vecs[j]) for j in members) / len(members),
        )
        chosen.append(central)
    mean_sim = [sum(cosine(v, u) for u in vecs) / len(vecs) for v in vecs]
    while len(chosen) < k:
        best = max(
            (i for i in range(len(vecs)) if i not in chosen),
            key=lambda i: -max(cosine(vecs[i], vecs[j]) for j in chosen)
            + 1e-9 * mean_sim[i],
        )
        chosen.append(best)
    return chosen


def english_fraction(words):
    """Fraction of tokens that are English stopwords — a cheap language probe.
    English prose lands well above 0.15; below it the English-centric
    analyses (contractions, greetings, function words) are unreliable."""
    if not words:
        return 0.0
    return round(sum(1 for w in words if w in STOPWORDS) / len(words), 3)


def load_register(reg_dir, is_chat, min_w, dropped):
    """Read one register's .txt files into samples. In chat registers, files
    sharing a '<bundle>__' filename prefix pool into one sample, so a day of
    short messages counts in aggregate instead of failing the gate one by
    one. The gate applies to the pooled bundle."""
    groups = {}
    for f in sorted(reg_dir.glob("*.txt")):
        cleaned = clean_sample(f.read_text(errors="replace"))
        if cleaned is None:
            dropped[f"{reg_dir.name}:forward/autoreply"] += 1
            continue
        key = f.stem.rsplit("__", 1)[0] if is_chat and "__" in f.stem else f.stem
        groups.setdefault(key, []).append(cleaned)
    samples = []
    for key, parts in groups.items():  # insertion order == sorted file order
        st = sample_stats("\n\n".join(parts), segments=parts)
        if st["n_words"] < min_w:
            dropped[f"{reg_dir.name}:too_short"] += len(parts)
            continue
        # The Step 2 naming convention puts the audience tag first:
        # <audience>__<slug>__<date>__<NNN>.txt. Untagged files carry None.
        st["audience"] = key.split("__", 1)[0] if "__" in key else None
        samples.append(st)
    return samples


def selftest():
    """Verify this copy of the script wasn't corrupted in transit. Asserts
    the cleaning and stats pipeline on a built-in fixture; exits non-zero on
    any mismatch."""
    fwd = "---------- Forwarded message ----------\nnot the user"
    assert clean_sample(fwd) is None, "forward not dropped"
    reply = (
        "Sounds good, let's do Tuesday! I'll bring the notes.\n\n"
        "On Mon, Jun 1, 2026 at 9:00 AM Alice <a@x.com> wrote:\n> how about tuesday?\n"
    )
    cleaned = clean_sample(reply)
    assert cleaned is not None and "tuesday?" not in cleaned, "quoted tail kept"
    assert "Alice" not in cleaned, "third-party name kept"
    sig = "Quick note.\nMore text here.\n-- \nBob Builder\nbob@x.com\n"
    assert "Builder" not in (clean_sample(sig) or ""), "signature kept"
    # Outlook/M365 inline reply — no "wrote:" line, un-prefixed quoted body.
    outlook = (
        "Sounds good, I'll send the deck tonight.\n\n"
        "________________________________\n"
        "From: Alice <a@x.com>\nSent: Mon, Jun 1, 2026 9:00 AM\n"
        "To: Bob <b@x.com>\nSubject: Re: deck\n\n"
        "Can you send the deck by EOD?\n"
    )
    cleaned = clean_sample(outlook)
    assert cleaned and "deck tonight" in cleaned, "outlook: user prose lost"
    assert "EOD" not in cleaned and "Alice" not in cleaned, "outlook: quoted body kept"
    # Same shape without the separator — the header block alone must truncate.
    cleaned = clean_sample(outlook.replace("________________________________\n", ""))
    assert cleaned and "deck tonight" in cleaned, "outlook (no sep): user prose lost"
    assert "EOD" not in cleaned, "outlook (no sep): quoted body kept"
    # A lone header-looking line in real prose is skipped, not a truncation point.
    cleaned = clean_sample("Two things.\nTo: everyone — thanks for the push.\nShip it Friday.\n")
    assert cleaned and "Ship it Friday" in cleaned, "lone header line over-truncated"
    # Top-of-message headers before any prose are skipped, body kept.
    cleaned = clean_sample("From: me\nTo: you\nSubject: hi\n\nActual body here.\n")
    assert cleaned == "Actual body here.", f"top headers mis-handled: {cleaned!r}"
    # Smart-quote normalization: typographic apostrophe must count as a contraction.
    st = sample_stats(clean_sample("I can’t make it… maybe later."))
    assert st["n_words"] == 6 and "can't" in st["words"], "smart-quote normalization broken"
    # Greetings aggregate on the greeting word, not the whole line with names.
    gstats = register_stats([sample_stats(clean_sample(t)) for t in
                             ("Hi Alice,\nsee you there.", "Hi Bob —\nworks for me.")])
    assert gstats["common_greetings"] == ["hi"], f"greetings leak names: {gstats['common_greetings']}"
    st = sample_stats("I can't make it today. Maybe tomorrow works?")
    # 8 tokens: "can't" is a single token (WORD keeps the internal apostrophe).
    assert st["n_words"] == 8, f"tokenizer drift: {st['n_words']}"
    stats = register_stats([st])
    assert stats["contractions_per_100_words"] > 0, "contraction detection broken"
    assert english_fraction(st["words"]) > 0.15, "language probe broken"
    docs = [sample_stats(t) for t in (
        "the quick brown fox jumps over the lazy dog near the river bank",
        "the quick brown fox jumps over the lazy dog near the river bank",
        "quarterly revenue projections need a careful review before the board meeting",
    )]
    picked = pick_exemplars(docs, 2)
    assert len(set(picked)) == 2 and 2 in picked, "exemplar diversity pick broken"
    # Stratified: a minority audience must get a reserved slot even when plain
    # diversity would spend both picks on the majority's topic spread.
    team_topics = (
        "the quick brown fox jumps over the lazy dog near the river bank",
        "quarterly revenue projections need a careful review before the board meeting",
        "deployment pipeline flaked again so the release train slips to thursday",
    )
    cust = "thanks so much for flagging this, the quick brown fox team will follow up"
    strat = [dict(sample_stats(t), audience="team") for t in team_topics]
    strat.append(dict(sample_stats(cust), audience="customer"))
    picked = pick_exemplars_stratified(strat, 2)
    assert any(strat[i]["audience"] == "customer" for i in picked), "stratified pick missed the minority audience"
    assert any(strat[i]["audience"] == "team" for i in picked), "stratified pick missed the majority audience"
    # Single-audience registers must be byte-identical to the plain picker.
    mono = [dict(sample_stats(t), audience="team") for t in team_topics]
    assert pick_exemplars_stratified(mono, 2) == pick_exemplars(mono, 2), "stratified not a no-op for single-audience"
    untagged = [sample_stats(t) for t in team_topics]
    assert pick_exemplars_stratified(untagged, 2) == pick_exemplars(untagged, 2), "stratified not a no-op for untagged"
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "dm"
        d.mkdir()
        msgs = ["ship it please :)", "lgtm, merging now", "can you rerun ci"]
        for i, m in enumerate(msgs, 1):
            (d / f"alice__2026-06-01__{i:03d}.txt").write_text(m)
        (d / "solo.txt").write_text("too short")
        drops = Counter()
        pooled = load_register(d, True, 10, drops)
        assert len(pooled) == 1 and pooled[0]["n_messages"] == 3, "pooling broken"
        assert pooled[0]["audience"] == "alice", "audience tag not parsed from bundle key"
        assert drops["dm:too_short"] == 1, "standalone short-drop broken"
        rs = register_stats(pooled)
        assert rs["n_samples"] == 1 and rs["n_messages"] == 3, "segment count broken"
        assert 0 < rs["emoji_per_message"] < 1, "per-message emoji rate broken"
        assert rs["words_per_sample_median"] == 10, "bundle median broken"
        assert rs["words_per_message_median"] == 3, "per-message median broken"
        email_dir = Path(td) / "external_email"
        email_dir.mkdir()
        (email_dir / "a__b__001.txt").write_text("word " * 40)
        unpooled = load_register(email_dir, False, 30, Counter())
        assert unpooled and unpooled[0]["n_messages"] == 1, "non-chat pooled"
        assert unpooled[0]["audience"] == "a", "audience tag not parsed for non-chat"
        (email_dir / "solo.txt").write_text("word " * 40)
        with_solo = load_register(email_dir, False, 30, Counter())
        assert any(s["audience"] is None for s in with_solo), "untagged file should carry None"
    # Abbreviations don't end sentences; citations and hedges are found.
    paper = (
        "Prior work suggests the effect is small (Smith & Lee, 2020). "
        "Wu et al. (2019) found otherwise, e.g. in larger samples [3, 4].\n\n"
        "We argue that the data were collected too early. However, the trend may hold."
    )
    assert len(sentences(paper)) == 4, f"abbreviation guard broken: {sentences(paper)}"
    lf = longform_stats([sample_stats(paper)])
    assert lf["citations_per_1000_words"]["parenthetical_author_year"] > 0, "parenthetical citation missed"
    assert lf["citations_per_1000_words"]["narrative_author_year"] > 0, "narrative citation missed"
    assert lf["citations_per_1000_words"]["numeric_brackets"] > 0, "numeric citation missed"
    assert lf["hedges_per_1000_words"] > 0 and lf["passive_per_100_sentences_approx"] > 0, "stance measures broken"
    assert lf["first_person_plural_per_1000_words"] > 0, "first person missed"
    assert "however" in lf["top_sentence_connectors"], "connector start missed"
    assert lf["paragraph_sentences_median"] == 2, "paragraph split broken"
    assert 0 < mattr(tokenize(paper)) <= 1, "mattr out of range"
    rows = compare_registers({"a": 10, "b": 1.0, "n_words": 5}, {"a": 30, "b": 1.1, "n_words": 900})
    assert [r[0] for r in rows] == ["a", "b"] and rows[0][3] and not rows[1][3], "compare marks broken"
    rewrite = paper.replace("(Smith & Lee, 2020)", "(Smith & Lee, 2021)").replace("We argue", "I'd say")
    rep = fidelity_report(paper, rewrite)
    assert rep["citations"][1] and rep["citations"][2], "fidelity missed a changed citation"
    assert rep["numbers"][1]["2020"] == 1 and rep["numbers"][2]["2021"] == 1, "fidelity missed a changed number"
    assert not any(v[1] or v[2] for v in fidelity_report(paper, paper).values()), "fidelity false positive"
    stats_txt = "The effect was small (p = .03, r = .32), as in (Smith, Lee, & Wu, 2020)."
    rep2 = fidelity_report(stats_txt, stats_txt.replace(".03", ".30"))
    assert rep2["numbers"][1][".03"] == 1, "fidelity missed a leading-dot number"
    assert CITE_PAREN.search(stats_txt), "multi-author citation missed"
    assert not CITE_PAREN.search("It shipped (March 2020) late."), "a date read as a citation"
    scale = 'Rated from "1" to "7" on a scale.'
    assert not any(v[1] or v[2] for v in fidelity_report(scale, scale.replace(" to ", " through ")).values()), "quote pairing broken"
    money = "It cost $5 and $10 later."
    assert not fidelity_report(money, money)["equations_and_code"][1] and not FIDELITY["equations_and_code"][0].search(money), "dollar amounts read as an equation"
    refs = "See Figure \\ref{fig:x} and \\eqref{eq:1}."
    assert fidelity_report(refs, refs.replace("fig:x", "fig:y"))["cross_references"][1], "LaTeX cross-reference missed"
    for t in ("The value is indeed high.", "It is between them.", "They are children.", "Sales are down."):
        assert not PASSIVE.search(t), f"passive false positive: {t}"
    for t in ("Effects were found.", "A choice was made.", "Samples were then analyzed.", "It was also shown."):
        assert PASSIVE.search(t), f"passive missed: {t}"
    assert not HEDGES.search("It began in May."), "the month read as a hedge"
    tops = compare_registers({"top_sentence_first_words": {"smith": 9.0}, "x": 1.0},
                             {"top_sentence_first_words": {"the": 9.0}, "x": 1.0})
    assert not any(r[3] for r in tops), "a top-N miss was marked"
    assert not any("audiences" in r[0] for r in compare_registers({"audiences": {"a": 3}}, {"audiences": {"a": 9}})), "audiences not skipped"
    tex = "As shown before \\citep[p.~4]{smith2020}, the effect holds."
    assert fidelity_report(tex, tex.replace("smith2020", "smith2021"))["citations"][1], "LaTeX citation missed"
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("samples_dir", type=Path, nargs="?")
    ap.add_argument("--out", type=Path, default=Path("analysis.json"))
    ap.add_argument("--exemplars", type=Path, default=Path("exemplars.md"))
    ap.add_argument("--min-words", type=int, default=30)
    ap.add_argument("--chat-min-words", type=int, default=10)
    ap.add_argument("--per-register", type=int, default=5)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--compare", nargs=2, metavar=("REFERENCE_JSON", "TARGET_JSON"))
    ap.add_argument("--ref-register")
    ap.add_argument("--target-register")
    ap.add_argument("--fidelity", nargs=2, metavar=("ORIGINAL", "REWRITE"))
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    if args.compare:
        compare_main(*args.compare, args.ref_register, args.target_register)
        return
    if args.fidelity:
        sys.exit(fidelity_main(*args.fidelity))
    if args.samples_dir is None:
        ap.error("samples_dir is required unless --selftest")

    analysis, ex_lines, dropped = {}, [], Counter()
    for reg_dir in sorted(p for p in args.samples_dir.iterdir() if p.is_dir()):
        reg = reg_dir.name
        is_chat = bool(CHAT_REGISTERS.match(reg))
        min_w = args.chat_min_words if is_chat else args.min_words
        samples = load_register(reg_dir, is_chat, min_w, dropped)
        if not samples:
            continue
        analysis[reg] = register_stats(samples)
        if not is_chat:
            analysis[reg]["longform"] = longform_stats(samples)
        ef = english_fraction([w for s in samples for w in s["words"]])
        analysis[reg]["english_stopword_fraction"] = ef
        analysis[reg]["non_english_suspected"] = ef < 0.15
        audiences = Counter(
            s["audience"] for s in samples if s.get("audience") is not None
        )
        analysis[reg]["audiences"] = dict(audiences)
        ex_lines.append(f"\n## Register: {reg}\n")
        for rank, i in enumerate(pick_exemplars_stratified(samples, args.per_register), 1):
            segs_i = samples[i]["segments"]
            # Render bundles message-wise so the distill step never mistakes
            # a bundle for one continuous text.
            body = "\n\n---\n\n".join(segs_i)
            if len(body) > 1800:
                body = body[:1800] + " […]"
            aud = samples[i].get("audience")
            tag = f" — {aud}" if aud else ""
            if len(segs_i) > 1:
                tag += f" — bundle of {len(segs_i)} messages"
            ex_lines.append(f"### Exemplar {rank}{tag}\n\n{body}\n")

    if not analysis:
        sys.exit("No usable samples found. Check the samples directory layout.")
    out = {
        "registers": analysis,
        "dropped": dict(dropped),
        "provenance": {r: a["n_messages"] for r, a in analysis.items()},
    }
    args.out.write_text(json.dumps(out, indent=2))
    args.exemplars.write_text("# Selected exemplars\n" + "\n".join(ex_lines))
    print(f"Wrote {args.out} and {args.exemplars}.")
    print(json.dumps(out["provenance"], indent=2))


if __name__ == "__main__":
    main()
