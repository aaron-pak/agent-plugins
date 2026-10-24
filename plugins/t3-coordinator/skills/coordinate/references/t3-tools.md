# t3-code MCP tools for coordinating

Checked against T3 Code's source at commit `67c0fc0` (2026-10-20). The live tool schemas win if they differ.

## Delegated tasks (children of this thread)

**`orchestrator_capabilities`** `{}`
Returns provider instances, models, each model's options, and the settings this thread passes on to children. Call it once before you pick a `target`.

**`delegate_task`**
- `task` (required): the brief. The child gets nothing else.
- `title`
- `role`: `implementation`, `research`, `review`, `design`, `test` or `general`
- `target`: `{ providerInstanceId, model, options }`. For example, Claude takes `options: {effort: "max", fastMode: true}` and Codex takes `{reasoningEffort: "max", serviceTier: "priority"}`. Use only options the model advertises.
- `isolation`: `shared` (default) or `worktree`
- `mode`: `async` (default) or `wait`
- `timeoutMs`: for `wait` only; the default is 10 minutes
- `clientRequestId`: unique per worker, stable across retries
- `runtimeMode` / `interactionMode`: leave both to inherit

The result includes `taskId`, `childThreadId`, `status` (`queued`, `running`, `waiting`, `completed`, `failed`, `cancelled` or `interrupted`), `summary`, `hasPendingQuestion` and `pendingApproval`. Completion wakes this thread.

**`task_status`** `{ taskId }`
Returns the same fields as `delegate_task`, plus `workState` (`working`, `waiting_for_children` or `result_available`). A finished turn with nested work still running is not a finished task.

**`task_cancel`** `{ taskId, reason?, clientRequestId? }`
Cancels the task, including any grandchildren.

## Any thread

**`t3_thread_launch`**
Starts a top-level thread that isn't linked to this one.
- `title` (required)
- `message`: the brief
- `workspaceStrategy`, one of:
  - `{type: "root"}`
  - `{type: "worktree", baseRef, branch?, startFromOrigin?}`
  - `{type: "existing_worktree", worktreePath, branch?}`
- `modelSelection`, `runtimeMode`, `interactionMode`, `projectId`, `attachments`

Leaving out `workspaceStrategy` means `root`; the thread doesn't inherit your worktree. There is no idempotency key.

**`create_threads`**
Starts 1–20 top-level threads that share your checkout. You can't give them their own worktrees.

**`t3_thread_list`** `{ projectId, statuses?, titleContains?, includeSubagents?, limit?, cursor? }`

**`t3_thread_read`** `{ threadId, view?: "messages" | "activity", afterPosition?, limit?, itemId?, textOffset? }`
Pages with `nextPosition`. Reading a direct child's full final answer marks its completion as delivered.

**`t3_thread_send`** `{ threadId, message, mode?: "auto" | "queue" | "steer" | "restart", clientRequestId? }`
The target can't have broader permission modes than yours. When sent to a child's `childThreadId` after its task finished, it starts a new task and returns that task's `taskId`.

**`t3_thread_wait`** `{ threadId, runId?, timeoutMs? }`
Reports status only. A timeout doesn't interrupt the thread.

**`t3_thread_interrupt`** `{ threadId, runId?, clientRequestId? }`

## Questions and approvals in a worker

**`t3_pending_request_list`**, **`t3_pending_request_read`**, **`t3_pending_request_respond`**
Pass `threadId: childThreadId`. These answer a worker's questions. Approvals stay with Aaron in that worker's thread.

## Worktrees

- **`t3_worktree_list`**: lists existing worktrees.
- **`t3_worktree_status`**: shows the state of a worktree.
- **`t3_thread_merge_back`**: merges a thread's worktree work back. Use it only when Aaron asks.
