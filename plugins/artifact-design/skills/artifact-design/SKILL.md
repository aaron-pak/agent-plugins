---
name: artifact-design
description: Design guidance and fundamentals for HTML artifacts. Load before writing any HTML artifact or page, including a skill-instructed Markdown one - Markdown is never a shortcut past the design pass.
---

<!--
Anthropic's Claude Code built-in `artifact-design` skill, captured from Claude Code 2.1.287
(2026-10-02), with its sibling `artifact-diagramming` skill carried as
`references/diagramming.md`. The text is the original except for the smallest edits that
make it work in any harness with any model, and make every page light-themed:
  1. Frontmatter: `description` and `when_to_use` merged into one description, and
     "Artifacts" read as "HTML artifacts".
  2. Page contract: the claude.ai Artifact tool's paragraphs are removed (skeleton, title
     scan, CDN allowlist, viewer frame, browser storage, size limit, icon). Format and
     Responsive stay; Theme-aware becomes a light-only Theme.
  3. "Design both themes" becomes "Design one light theme", and the chart and diagram
     notes about reading in both themes are trimmed to match.
  4. A References section replaces the tool routing that loaded artifact-diagramming.
  5. Mentions of publishing, the gallery, the publish skeleton, runtime capabilities, the
     `db` store, ArtifactCheck, and live-viewer updates are removed or reworded;
     "CLAUDE.md" becomes "AGENTS.md or CLAUDE.md"; Google Fonts is no longer described
     as the one host a CSP allows.
-->

## Page contract

These are the rules for the file itself; the design guidance below builds on them.

**Format**: Always author the page as `.html`. Write a `.md` file only when a loaded skill explicitly instructs it. When the user shares a markdown document or asks to turn one into an artifact, author an HTML page based on its content — preserve its substance, and design the page as you would any other artifact rather than transcribing the markdown one-to-one.

**Responsive**: The page must also work at phone width (about 400px), and the page body must never scroll horizontally. Keep a side gutter of at least 16px at every width: set it once as side padding on `body` or one outer wrapper, and give that element its vertical padding with `padding-block`, never a `padding` shorthand that zeroes the sides. Use relative units. Let flex and grid rows wrap or stack to one column when narrow, and give any flex or grid child that holds running text, code or a table `min-width: 0`, so long content wraps or scrolls inside it instead of pushing the page wider. Put `max-width: 100%` on images and on any `aspect-ratio` box, and give nothing a `min-width` wider than the screen. Only tables, diagrams and code blocks may be wider, each inside its own `overflow-x: auto` container.

**Theme**: Every page is light. Define every color as a token on `:root`, in this shape (token names and count are the design's own):
```css
:root { --bg: …; --fg: …; --accent: …; color-scheme: light }  /* every token, light values */
body { background: var(--bg); color: var(--fg) }
```
Add no `prefers-color-scheme` media query and no `[data-theme]` blocks, and no component rule uses a literal color outside the tokens. `body` keeps that explicit token background, so the page looks the same wherever it is opened.

Work the way the design lead at a small, versatile studio would: give each client a visual identity at the level of treatment the task calls for. Make deliberate choices about palette, typography, and layout that are specific to this subject, and avoid templated designs.

## References

- `references/diagramming.md` — Diagramming know-how for HTML artifacts - when a picture earns its place, how to draw one that shows the real mechanism, and the inline-SVG mechanics that keep it legible. Read it before drawing any diagram.

## Read the request first

Decide the treatment; designing is a given. A doc gets the same craft as a landing page; only the treatment differs. Format is a separate matter: author HTML, and write Markdown only when a loaded skill explicitly instructs it. A Markdown page uses almost none of the craft below and is never a way to save time.

Many requests call for a more utilitarian treatment: a plan, a memo, a demo. Make it polished, with real typographic hierarchy, considered spacing, and a proper palette, but avoid over-designing. Most pages don't need a flashy, gigantic hero. Keep flourishes tasteful and limited.

Some requests call for an editorial treatment: a landing page, a game, an app or tool they'll keep or share.

If unsure: a well-composed page is always acceptable; an over-designed visual identity sometimes isn't.

Fundamentals below apply to everything. Follow the editorial process after them only when that reading calls for it.

## Fundamentals for every artifact

**Respect what already exists.** Look for an existing design system first: AGENTS.md or CLAUDE.md, a tokens or theme file, existing component styles. When one exists, apply it; everything below fills gaps and never overrides. Precedence is always the user's own words, then the project's existing system, then your choices.

**Ground it in the subject.** If the subject isn't already clear, define it: one concrete subject, its audience, and the page's single job. Distinctive choices come from the subject's own world: its materials, instruments, and vernacular. Whatever the treatment, include at least one detail only this subject would have (its real units and scales, its document conventions, its terms of art) as content rather than ornament; it costs nothing even on a plain page. Use real content throughout and never lorem ipsum.

**Pair typefaces.** Typography determines how the page reads even when the page isn't about typography. Google Fonts is the one font host to link; link it directly (`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=...&display=swap">`). A face from anywhere else must be inlined as a @font-face data URI, or the browser may silently use a fallback. In both cases, declare a real fallback stack. Keep running text near 65 characters wide. Set a type scale and keep to it. Give headings `text-wrap: balance`, give body text comfortable spacing, and give uppercase labels a little letter-spacing.

**Load libraries instead of inlining them.** When the page really needs a library (React, a charting or highlighting package), load its UMD build from cdnjs with one pinned `<script src="https://cdnjs.cloudflare.com/ajax/libs/...">` placed before the inline script that uses its global; don't inline the library's source or hand-write a substitute. Only the script loads this way; a library's stylesheet still has to be inlined. The page's own CSS and JS, its images, and its data ship with the page. Most pages don't need any library; use one only when it does substantial work for the page.

**Choose neutrals deliberately.** A pure mid-grey looks unconsidered; a grey with a slight hue bias toward the page's accent looks intentional. Pure white and near-black are fine backgrounds when they suit the subject, as long as you chose the neutral deliberately instead of inheriting a default.

**Design one light theme.** Every page is light. The bare `:root` block defines the complete palette as tokens and sets `color-scheme: light`, so native form controls and scrollbars follow the palette. Add no `@media (prefers-color-scheme: dark)` block and no `[data-theme]` blocks. Style components through the tokens. `body` must set an explicit `background` from a token; a transparent body shows whatever is behind the page. Every element that sets a color takes it from the same token set as the surface behind it, never from a stray literal. Keep contrast legible and keep the accent working on the background.

**Use layout for spacing.** Lay out sibling groups with flex or grid and `gap` instead of per-element margins, which collapse or double without warning. Keep a side gutter of at least 16px at every width: set it once as side padding on `body` or one outer wrapper, whose vertical padding uses `padding-block` and never a `padding` shorthand that zeroes the sides. Let rows wrap or stack to one column at phone width (about 400px). Give images and any `aspect-ratio` box `max-width: 100%`, and don't give anything a `min-width` wider than the screen. Only wide tables, code, and diagrams may exceed it; give each `overflow-x: auto` on its own container so the page body never scrolls sideways. Size a one-screen app with `height: 100%` on `html` and `body` instead of `100vh`. Use `font-variant-numeric: tabular-nums` wherever digits line up in columns.

**Make repeated elements consistent.** For cards in a row, label/value pairs down a list, or badges on sibling items, use the same edges, baselines, and inner padding on each, and put any recurring element in the same place on each. Let content set a container's height and pick a column count the items fill, so nothing stretches over empty space or sits alone in a row. Make text that can outgrow its track wrap or scroll in its own container; clipped text is a bug.

**Use card styling selectively.** Border, fill, radius, and shadow each mark an element as a separate object. Apply them by role, to set off the one element that needs it; applying the same radius and shadow to every block flattens the hierarchy. Open with big-number tiles only when those figures are the point of the page.

**Draw charts to scale.** Place marks, ticks, and labels with one scale, and make every label name a value the chart actually reaches. Color chart text from the theme tokens. Keep marks, labels, and edges clear of one another and inside the drawing's bounds; in SVG, leave room in the viewBox for the outermost labels and give every drawn shape an explicit fill.

**Make the page complete at rest.** Everything meant to be read is visible once the page has loaded, with no scrolling to trigger it; that first still frame is what a thumbnail, a shared link, and a skimming reader all see. A section may animate in, but from a visible resting state, never left at `opacity: 0` waiting for an observer. Size a hero to its content instead of to the viewport; a `100vh` opener pushes the rest of the page out of that first frame. A tool or app opens in a realistic working state: the user's real data where it exists, otherwise example rows, a loaded sample, or a plausibly filled form, clearly marked as examples and never presented as the user's own figures. The first view shows what the tool does; an empty shell waiting for input shows nothing.

**Avoid AI-generated design.** AI-generated design currently clusters around a few looks: warm cream (#F4F1EA) with a serif display and terracotta accent; near-black with a lone acid-green or vermilion pop; broadsheet hairline rules with dense columns; a purple-to-blue gradient hero on white; Inter or Space Grotesk as the "safe" face; emoji as section markers; everything centered; `rounded-lg` everywhere; accent bar/rail on rounded cards. When the user specifies a visual direction, follow it exactly; their words always win, including when they ask for one of these looks. When nothing is specified, don't use that freedom on one of these defaults.

**Build cleanly.** Watch for overlapping elements, cascade collisions, and silent font fallbacks. Close every non-void element, double-quote attributes, give keyboard focus a visible state, and respect `prefers-reduced-motion`. Give every form control a stable `id`. For generative or decorative graphics, use Canvas or WebGL instead of hand-writing long SVG path data.

**CSS rules.** When writing the CSS, watch your selector specificity. It is easy to generate classes that cancel each other out, e.g. a type-based selector like `.section` and an element-based one like `.cta` both setting padding and margins between sections. Structure the cascade so it doesn't undo your spacing unnoticed.

**Writing the copy.** Treat words as design material and never as decoration. Write from the user's side of the screen: name things by what people recognize instead of how the system is built (a person manages *notifications*; they don't manage *webhook config*). Use active voice; a control states exactly what happens ("Publish", then a toast that says "Published"). Errors explain what went wrong and how to fix it, without apologies or vagueness. Prefer specific to clever. Write plainly, the way a knowledgeable person would talk. Avoid mannered devices: asides set off by em-dashes, "not X, but Y" framing, colon-then-reveal sentences, scare quotes around invented labels, and stock phrases such as "worth noting" or "honest caveat". Prefer short, direct sentences over compressed or clever phrasing.

**Name the page like a product; don't caption it.** The `<title>` is the page's name in the browser tab, and it gives the reader a first impression of the care taken. Give the page a real name: a short noun phrase, typically two to four words, specific to the subject; or, for a page that exists to answer one question, that question itself, which then is the page's name. When the user already has a specific name for the thing, use that name for the title rather than coining a new one. Stop at the name; a title that adds its own explanation after a dash or colon reads as generated filler. The name must also identify the page among many: in tabs and history it appears beside dozens of other pages, and a generic category label that could apply to any of them fails as a name just as an appended explanation does. When a candidate title combines the name with a generic word (a greeting, a category, a page-type label), keep the name; a trim that drops the identifying part and keeps the generic word produces a title that could apply to any page. This rule removes explanations and doesn't require brevity: a multi-word title that already reads as one specific name is finished, and shortening it further only makes it generic. Put the explanation on the page, under the title.

**Structure is information.** Structural devices (numbering, eyebrows, dividers, labels) should encode something true about the content instead of decorating it. Many generic designs use numbered markers (01 / 02 / 03), but those fit only if the content actually is a sequence, such as a real process or a typed timeline where the order is information the reader needs. Before adding numbered markers or similar devices, check that they actually make sense.

**When the page is a UI (dashboard, tool).** It is scanned and operated instead of read top to bottom, so the craft shifts from typography to information design. Put the summary before the detail. Encode state in form as well as in numbers (a pill, a chip, a severity stripe) so that whatever needs attention is visible at a glance. Semantic color (good / warning / critical) is separate from the accent hue and doesn't count as your accent. Give sparklines and charts the same care as type: an area fill, a faint grid, an emphasized endpoint. Interactive elements should look interactive.

## Process

Start from what the viewer should be able to do on the page, in addition to what they will read.

Before writing the page, settle a short design plan (a compact token system) and write it into the file itself, as the `:root` block at the top of the page's `<style>`, rather than into your reply:
- **Color**: the palette as 4-6 named color tokens.
- **Type**: font tokens for 2+ roles: a characterful display face used with restraint, a complementary body face, and a utility face for captions or data if needed.
- **Layout**: the layout concept as a one-line comment above the tokens.

Then build the rest of the page from those tokens, deriving every color and type decision from them. The plan is working material, not part of the answer: unless the user asks about the design, one plain sentence on the direction is the most to say about it, with no hex values or font names.

**Write, check once, deliver.** Before handing the page over you may look at the rendered page once, where this session offers a way, such as one screenshot of the local file; if the session offers none, skip the look. The look is optional: if you take it, make one pass of edits for what it shows, without a second look; then deliver. For a page that charts real numbers, take the look rather than skip it, and spend it on the chart. A page whose point is logic (dates, money, scoring, parsing) may get one more check before delivery: one run of a pure function on a sample input, or one syntax check of its script; nothing more. None of this becomes a loop, because the user is waiting for the page: no second screenshot, no scripts that probe the DOM, no re-running a check that passed. Review happens on the finished page, and further polish is for the user to request; if the user reports something visibly broken (a clipped column, unreadable text, a control that does nothing), fix that, take at most one more look if the session offers a way, and deliver once more.

## When the request is editorial

The stance changes here: the client has already rejected proposals that felt templated, and is paying for a distinctive point of view. Make opinionated decisions, and take one real aesthetic risk where it serves the work.

Review the design plan against the subject before building: if any part of it reads like the generic default you would produce for any similar page, revise that part in the plan itself, without narrating the revision to the user. Write the code only after the plan is specific to this subject, following the revised plan exactly.

**Principles** 

- The hero states the thesis: open with the most characteristic thing in the subject's world (headline, image, live demo, interactive moment). 
- Typography sets the personality of the page. Pair the display and body faces deliberately, avoiding the families you would use on any other project, and set a clear type scale with intentional weights, widths, and spacing. Make the type treatment itself a memorable part of the design instead of a neutral container for the content. 
- Use motion deliberately. Think about whether and where animation can serve the subject: a page-load sequence, hover micro-interactions, ambient atmosphere. One orchestrated moment is usually more effective than scattered effects; choose what the direction calls for. However, sometimes less is more, and extra animation adds to the impression that the design is AI-generated. 
- Match complexity to the vision. Maximalist directions need elaborate execution; minimal directions need precision in spacing, type, and detail. Elegance is executing the chosen vision well.
- Put your boldness in one place; keep everything around it quiet. If the accent clashes with the background, shift it toward an analogous hue or desaturate it instead of replacing it.
