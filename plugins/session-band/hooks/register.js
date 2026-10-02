import { atom, read, update } from 'claude-code';
const STYLES = ['cozy', 'trail', 'peek'];
const DEFAULT_WARN_AT = 80;
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const EMPTY = {
    model: null,
    project: null,
    branch: null,
    dirty: null,
    percent: null,
    tokens: null,
    window: null,
    usd: null,
    limit: null,
    startedAt: null,
    lastActiveAt: null,
    activity: null,
    lastTurn: null,
    todos: [],
    cheers: 0,
    oops: 0,
};
const info = atom({ plugin: 'session-band', key: 'info' }, EMPTY);
const style = atom({ plugin: 'session-band', key: 'style' }, 'cozy');
export const register = (on, options) => {
    const warnAt = typeof options.warnAt === 'number' ? options.warnAt : DEFAULT_WARN_AT;
    let hasWarned = false;
    let turnTools = 0;
    let turnFiles = new Set();
    on('session.start', async ($, e, next) => {
        await $.command.register({
            name: 'band',
            description: 'Switch the session band style',
            argumentHint: '[cozy|trail|peek]',
        });
        const saved = await $.store.get('style');
        if (isStyle(saved)) {
            await update($, style, () => saved);
        }
        const [usage, model, repo, git] = await Promise.all([
            $.session.usage(),
            $.session.model(),
            $.session.repo(),
            gitState($),
        ]);
        await patch($, () => ({
            ...figures(usage),
            model: prettyModel(model),
            project: repo?.name?.split('/').pop() ?? basename(repo?.root ?? e.cwd),
            startedAt: usage.startedAt,
            ...git,
        }));
        return next(e);
    });
    on('session.measure', async ($, e, next) => {
        await patch($, () => figures(e));
        const percent = e.context.percent;
        if (percent !== undefined && percent >= warnAt && !hasWarned) {
            hasWarned = true;
            $.ui.toast(`Context is ${percent}% full. Run /compact soon.`, { timeoutMs: 8000 });
        }
        else if (percent !== undefined && percent < warnAt) {
            hasWarned = false;
        }
        return next(e);
    });
    on('prompt.submit', async ($, e, next) => {
        turnTools = 0;
        turnFiles = new Set();
        const now = await $.clock.now();
        await patch($, () => ({ lastActiveAt: now }));
        return next(e);
    });
    on('tool.call', async ($, e, next) => {
        if (e.agentId !== undefined) {
            return next(e);
        }
        const activity = describe(e.tool_use_id, e);
        turnTools += 1;
        await patch($, () => ({ activity }));
        const ran = await next(e);
        const isFailed = ran.deny === undefined && ran.isError === true;
        if (!isFailed && FILE_TOOLS.has(String(e.tool)) && 'file_path' in e && typeof e.file_path === 'string') {
            turnFiles.add(e.file_path);
        }
        const todoId = e.tool === 'TaskCreate' && ran.deny === undefined ? ran.result?.task?.id : undefined;
        await patch($, now => ({
            activity: now.activity?.id === activity.id ? null : now.activity,
            todos: nextTodos(now.todos, e, todoId),
            oops: isFailed ? now.oops + 1 : now.oops,
        }));
        return ran;
    });
    on('turn.complete', async ($, e, next) => {
        if (e.agentId !== undefined) {
            return next(e);
        }
        const [git, now] = await Promise.all([gitState($), $.clock.now()]);
        await patch($, before => ({
            ...git,
            activity: null,
            lastActiveAt: now,
            lastTurn: {
                seconds: Math.round(e.durationMs / 1000),
                tools: turnTools,
                files: turnFiles.size,
                isError: e.reason === 'error',
            },
            cheers: e.reason === 'answer' ? before.cheers + 1 : before.cheers,
        }));
        return next(e);
    });
    // /clear starts a fresh conversation without a new session.start.
    on('session.end', async ($, e, next) => {
        if (e.reason === 'clear') {
            hasWarned = false;
            const now = await $.clock.now();
            await patch($, () => ({ ...figures(null), startedAt: now, lastTurn: null, todos: [], activity: null }));
        }
        return next(e);
    });
    on('command.run', { command: 'band' }, async ($, e) => {
        const asked = e.args.trim().toLowerCase();
        const current = await read($, style);
        if (asked !== '' && !isStyle(asked)) {
            return { text: `No band style "${asked}". Try ${STYLES.join(', ')}.` };
        }
        const picked = isStyle(asked) ? asked : (STYLES[(STYLES.indexOf(current) + 1) % STYLES.length] ?? 'cozy');
        await update($, style, () => picked);
        await $.store.set('style', picked);
        return { text: `Band style: ${picked} (${STYLES.join(' · ')}). Run /band again for the next one.` };
    });
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
            return next(e);
        }
        const { Client } = $.ui.resolve(e);
        const [now, picked, known] = await Promise.all([$.clock.now(), read($, style), read($, info)]);
        const props = bandProps(known, picked, e.props.isWorking, warnAt, e.props.bodyColumns, now);
        return (<Client key="band" module="./band.tsx" props={props} width={e.props.bodyColumns} height={picked === 'peek' ? 2 : 3}/>);
    });
};
function patch($, change) {
    return update($, info, now => ({ ...now, ...change(now) }));
}
function isStyle(value) {
    return typeof value === 'string' && STYLES.includes(value);
}
function figures(usage) {
    const limit = usage?.rateLimits.find(one => one.kind === 'five_hour') ?? usage?.rateLimits[0];
    return {
        percent: usage?.context.percent ?? null,
        tokens: usage?.context.tokens ?? null,
        window: usage?.context.window ?? null,
        usd: usage?.cost?.usd ?? null,
        limit: limit === undefined ? null : { kind: limit.kind, percent: limit.percentUsed, resetsAt: limit.resetsAt ?? null },
    };
}
async function gitState($) {
    try {
        const [head, status] = await Promise.all([
            $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 3000 }),
            $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 3000 }),
        ]);
        if (head.exitCode !== 0) {
            return { branch: null, dirty: null };
        }
        return {
            branch: head.stdout.trim(),
            dirty: status.exitCode === 0 ? status.stdout.split('\n').filter(line => line.trim() !== '').length : null,
        };
    }
    catch {
        return { branch: null, dirty: null };
    }
}
function describe(id, e) {
    const text = (key) => (typeof e[key] === 'string' ? e[key] : '');
    const tool = String(e.tool);
    switch (tool) {
        case 'Read':
            return { id, verb: 'Reading', target: basename(text('file_path')) };
        case 'Edit':
        case 'NotebookEdit':
            return { id, verb: 'Editing', target: basename(text('file_path') || text('notebook_path')) };
        case 'Write':
            return { id, verb: 'Writing', target: basename(text('file_path')) };
        case 'Bash':
            return { id, verb: 'Running', target: text('description') || text('command').split('\n')[0] || '' };
        case 'Grep':
        case 'Glob':
            return { id, verb: 'Searching', target: text('pattern') };
        case 'WebFetch':
            return { id, verb: 'Fetching', target: hostOf(text('url')) };
        case 'WebSearch':
            return { id, verb: 'Searching the web for', target: text('query') };
        case 'Agent':
        case 'Task':
            return { id, verb: 'Delegating', target: text('description') };
        case 'TodoWrite':
        case 'TaskCreate':
        case 'TaskUpdate':
            return { id, verb: 'Planning', target: '' };
        default:
            return { id, verb: 'Using', target: tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool };
    }
}
function nextTodos(todos, e, createdId) {
    if (e.tool === 'TodoWrite' && Array.isArray(e.todos)) {
        return e.todos.map((todo, i) => ({
            id: String(i),
            subject: todo.content,
            activeForm: todo.activeForm ?? null,
            status: todo.status,
        }));
    }
    if (e.tool === 'TaskCreate' && createdId !== undefined) {
        const subject = typeof e.subject === 'string' ? e.subject : 'Task';
        const activeForm = typeof e.activeForm === 'string' ? e.activeForm : null;
        return [...todos, { id: createdId, subject, activeForm, status: 'pending' }];
    }
    if (e.tool === 'TaskUpdate' && typeof e.taskId === 'string') {
        if (e.status === 'deleted') {
            return todos.filter(todo => todo.id !== e.taskId);
        }
        return todos.map(todo => todo.id !== e.taskId
            ? todo
            : {
                ...todo,
                subject: typeof e.subject === 'string' ? e.subject : todo.subject,
                activeForm: typeof e.activeForm === 'string' ? e.activeForm : todo.activeForm,
                status: e.status === 'pending' || e.status === 'in_progress' || e.status === 'completed' ? e.status : todo.status,
            });
    }
    return todos;
}
function bandProps(known, picked, isWorking, warnAt, columns, now) {
    const done = known.todos.filter(todo => todo.status === 'completed').length;
    const current = known.todos.find(todo => todo.status === 'in_progress') ?? known.todos.find(todo => todo.status === 'pending');
    const resetsAt = known.limit?.resetsAt == null ? NaN : Date.parse(known.limit.resetsAt);
    return {
        style: picked,
        columns,
        isWorking,
        isHigh: known.percent !== null && known.percent >= warnAt,
        model: known.model,
        place: known.project === null ? null : known.branch === null ? known.project : `${known.project} ⎇ ${known.branch}`,
        dirty: known.dirty,
        percent: known.percent,
        usage: known.tokens === null || known.window === null ? null : `${shortCount(known.tokens)}/${shortCount(known.window)}`,
        cost: known.usd === null ? null : `$${known.usd.toFixed(2)}`,
        limit: known.limit === null
            ? null
            : {
                label: known.limit.kind === 'five_hour' ? '5h' : known.limit.kind === 'seven_day' ? '7d' : known.limit.kind,
                percent: Math.round(known.limit.percent),
                resets: Number.isNaN(resetsAt) ? null : duration(resetsAt - now),
            },
        elapsedMs: known.startedAt === null ? null : now - known.startedAt,
        idleMs: known.lastActiveAt === null ? null : now - known.lastActiveAt,
        activity: known.activity === null
            ? null
            : known.activity.target === ''
                ? `${known.activity.verb}…`
                : `${known.activity.verb} ${known.activity.target}…`,
        lastTurn: known.lastTurn === null
            ? null
            : known.lastTurn.isError
                ? `Last turn hit an error after ${known.lastTurn.seconds}s`
                : `Last turn ${known.lastTurn.seconds}s · ${plural(known.lastTurn.tools, 'tool')} · ${plural(known.lastTurn.files, 'file')} changed`,
        todos: known.todos.length === 0
            ? null
            : { done, total: known.todos.length, current: current === undefined ? null : (current.activeForm ?? current.subject) },
        cheers: known.cheers,
        oops: known.oops,
    };
}
function prettyModel(id) {
    const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(id);
    if (match === null) {
        return id;
    }
    const [, family = '', major = '', minor] = match;
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor === undefined || minor.length > 2 ? '' : `.${minor}`}`;
}
function basename(path) {
    return path.split('/').filter(part => part !== '').pop() ?? path;
}
function hostOf(url) {
    return /^[a-z]+:\/\/([^/]+)/i.exec(url)?.[1] ?? url;
}
function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
function duration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60_000));
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
function shortCount(tokens) {
    if (tokens >= 1_000_000) {
        return `${Number((tokens / 1_000_000).toFixed(1))}M`;
    }
    return tokens < 1000 ? String(tokens) : `${Math.round(tokens / 1000)}k`;
}
