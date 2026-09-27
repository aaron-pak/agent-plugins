---
name: implement-with-notes
description: Implement a spec while maintaining a running implementation-notes.html that captures design decisions, deviations, tradeoffs, and open questions.
disable-model-invocation: true
---

Implement <spec>. As you work maintain a running implementation-notes.html file that captures anything I should know about how the implementation diverges from or interprets the spec, including:

- Design decisions: choices you made where the spec was ambiguous
- Deviations: places where you intentionally departed from the spec, and why
- Tradeoffs: alternatives you considered and why you picked what you did
- Open questions: anything you'd want me to confirm or revise

Skip routine mechanics that don't change behavior or surprise the reader. Write each note so it stands on its own — the reader hasn't read the spec or the code. Include whatever context is needed inline (for example: a paraphrase of what the spec said, a before/after, a code snippet, naming what part of the product this affects, etc.).
