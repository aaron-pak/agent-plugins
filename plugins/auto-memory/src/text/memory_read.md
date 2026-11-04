Read one memory document from a memory store by its store id and path. The result carries the document's version token — pass it as if_version when you next memory_write this path in the same store.

Read and update your memory often so corrections stick. Treat memories as past snapshots to verify against current sources, not the definitive answer.

## When to access memories
- When memories seem relevant, or the user references prior work with them or others in their organization.
- You MUST access memory when the user explicitly asks you to check, recall, or remember.
- Call memory_list early when context about the project would help, and always before telling the user you do not have something; if a listed document looks relevant, memory_read it.
- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.
- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering the user or building assumptions based solely on information in memory records, verify that the memory is still correct and up-to-date by reading the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now — and update or remove the stale memory rather than acting on it.

## Before recommending from memory

A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:

- If the memory names a file path: check the file exists.
- If the memory names a function or flag: grep for it.
- If the user is about to act on your recommendation (not just asking about history), verify first.

"The memory says X exists" is not the same as "X exists now."

A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.
