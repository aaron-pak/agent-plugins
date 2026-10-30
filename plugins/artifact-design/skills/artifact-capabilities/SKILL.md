---
name: artifact-capabilities
description: 'Runtime capabilities a published Artifact page can be granted — behavior static HTML cannot provide on its own, such as the page reading live or connected data, remembering what people do on it (a poll, a sign-up sheet, a checklist, a document edited in place — it saves new versions of itself), keeping state shared across viewers, knowing who is viewing, asking Claude a question of its own, storing files people add, handing the viewer a file to save, or using the viewer''s camera, microphone, location, screen or device motion. Serves this user''s live capability roster and the typed call definitions. Load it whenever any such runtime behavior would make an artifact more useful, before writing the page.'
---

No runtime capabilities are available on this machine: claude.ai isn't here, and the Artifact tool publishes static `file://` pages. So the roster is empty. Build the page as static HTML, CSS and JS, and leave out `capabilities` and `window.claude`:

- Keep what one viewer changes in `localStorage`, as the page contract's browser-storage rules describe, with every key prefixed by the page's name. Nothing is shared between viewers or read back by Claude.
- Take photos, audio and other files through file inputs or drag-and-drop, and read them with `FileReader`.
- A page can hand the viewer a file with a plain `<a download>` link or a `blob:` URL, since a local page isn't sandboxed.
- Live data the page would query has to be written into the page when it is published.
