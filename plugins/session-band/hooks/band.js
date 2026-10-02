const TICK_MS = 120;
const NAP_AFTER_MS = 3 * 60_000;
const ORANGE = '#D77757';
const RED = '#E5484D';
const PINK = '#F27BA8';
const SKY = '#7FB8E6';
const AMBER = '#E0A040';
const GREEN = '#6CBF8B';
const GOLD = '#F2C14E';
const EYE = '#000000';
const SPRITE_WIDTH = 9;
const CENTER = 4;
const HEADS = {
    open: ' ▐▛███▜▌ ',
    glance: ' ▐█▜██▛▌ ',
    closed: ' ▐█████▌ ',
    wide: ' ▐▀███▀▌ ',
};
const EYE_CELLS = { open: [2, 6], glance: [3, 6], closed: [], wide: [2, 6] };
const ARMS_UP = '▝▜█████▛▘';
const ARMS_DOWN = '▗▜█████▛▖';
const FEET = ['  ▘▘ ▝▝  ', '  ▝▝ ▘▘  '];
// Claude Code's own spinner glyphs, out and back.
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const VERBS = ['Scuttling', 'Clauding', 'Pinching tokens', 'Sidestepping', 'Tidepooling', 'Clawing through it'];
const Band = (props, surface) => {
    const { Box, Text } = surface.elements;
    let state = surface.state;
    if (state === undefined) {
        const live = {
            props,
            tick: 0,
            propsTick: 0,
            x: 0,
            heartUntil: -1,
            cheerUntil: -1,
            oopsUntil: -1,
            seenCheers: props.cheers,
            seenOops: props.oops,
        };
        state = { live, frame: '' };
        surface.setState(state);
        surface.every(TICK_MS, () => advance(surface));
        surface.onPointer(event => pet(surface, event));
    }
    receive(state.live, props);
    return (<Box flexDirection="column">
      {compose(state.live, widthOf(surface)).map(line => (<Text wrap="truncate-end">
          {line.map(({ text, ...style }) => (<Text {...style}>{text}</Text>))}
        </Text>))}
    </Box>);
};
export default Band;
// New props: note when they came, and start a cheer or a flinch for a new turn or a failed tool.
function receive(live, props) {
    if (live.props !== props) {
        live.propsTick = live.tick;
    }
    if (props.cheers > live.seenCheers) {
        live.cheerUntil = live.tick + 16;
    }
    if (props.oops > live.seenOops) {
        live.oopsUntil = live.tick + 12;
    }
    live.seenCheers = props.cheers;
    live.seenOops = props.oops;
    live.props = props;
}
function advance(surface) {
    const state = surface.state;
    if (state === undefined) {
        return;
    }
    const live = state.live;
    live.tick += 1;
    if (live.props.style === 'trail') {
        live.x += Math.sign(trailTarget(live.props.percent, trailLayout(widthOf(surface)).track) - live.x);
    }
    repaint(surface, state);
}
function pet(surface, event) {
    const state = surface.state;
    if (state === undefined || event.type !== 'down') {
        return;
    }
    const left = state.live.props.style === 'trail' ? state.live.x : 1;
    if (event.y <= 2 && event.x >= left && event.x < left + SPRITE_WIDTH) {
        state.live.heartUntil = state.live.tick + 14;
        repaint(surface, state);
    }
}
function repaint(surface, state) {
    const frame = JSON.stringify(compose(state.live, widthOf(surface)));
    if (frame !== state.frame) {
        surface.setState({ live: state.live, frame });
    }
}
function widthOf(surface) {
    return surface.columns > 0 ? surface.columns : (surface.state?.live.props.columns ?? 80);
}
function compose(live, columns) {
    const lines = live.props.style === 'trail' ? trail(live, columns) : live.props.style === 'peek' ? peek(live, columns) : cozy(live, columns);
    return lines.map(merge);
}
// ── Cozy: Clawd on the left, three lines about the session beside him ──────────
function cozy(live, columns) {
    const { props } = live;
    const width = Math.max(10, columns - SPRITE_WIDTH - 3);
    const [head, body, feet] = clawd(live, false);
    const sep = { text: '  ·  ', dimColor: true };
    const title = [
        ...(props.model === null ? [] : [{ text: props.model, color: ORANGE, bold: true }, sep]),
        ...place(props),
        ...(props.elapsedMs === null ? [] : [sep, { text: `◷ ${clock(elapsed(live))}`, dimColor: true }]),
    ];
    const meters = [
        { text: 'ctx ', dimColor: true },
        ...bar(props.percent, 12, props.isHigh ? RED : ORANGE),
        { text: ' ' },
        percentText(props),
        ...(props.limit === null
            ? []
            : [
                sep,
                { text: `${props.limit.label} `, dimColor: true },
                ...bar(props.limit.percent, 6, props.limit.percent >= 80 ? RED : SKY),
                { text: ` ${props.limit.percent}%` },
                ...(props.limit.resets === null ? [] : [{ text: ` ↻${props.limit.resets}`, dimColor: true }]),
            ]),
        ...(props.cost === null ? [] : [sep, { text: props.cost }]),
    ];
    const todo = todoChip(props);
    const now = status(live);
    const doing = todo === null || props.isWorking === false
        ? now
        : [...fit(now, Math.max(0, width - todo.length - 2)), { text: '  ' }, ...todo];
    return [
        [{ text: ' ' }, ...head, { text: '  ' }, ...fit(title, width)],
        [{ text: ' ' }, ...body, { text: '  ' }, ...fit(meters, width)],
        [{ text: ' ' }, ...feet, { text: '  ' }, ...fit(doing, width)],
    ];
}
// ── Trail: Clawd walks a track that fills as the context window does ───────────
function trailLayout(columns) {
    const stats = columns >= 72 ? 30 : columns >= 40 ? 14 : 0;
    return { track: Math.max(SPRITE_WIDTH, columns - stats - (stats > 0 ? 2 : 0)), stats };
}
function trailTarget(percent, track) {
    return Math.round((Math.min(100, Math.max(0, percent ?? 0)) / 100) * (track - SPRITE_WIDTH));
}
function trail(live, columns) {
    const { props } = live;
    const { track, stats } = trailLayout(columns);
    const x = Math.min(live.x, track - SPRITE_WIDTH);
    const isWalking = x !== trailTarget(props.percent, track);
    const [head, body, feet] = clawd(live, isWalking);
    const ground = [];
    const steps = [...plain(feet)];
    for (let column = 0; column < track; column++) {
        const foot = steps[column - x];
        if (foot !== undefined && foot !== ' ') {
            ground.push({ text: foot, color: ORANGE });
        }
        else if (props.percent !== null && column <= x + CENTER) {
            ground.push({ text: '━', color: props.isHigh ? RED : ORANGE });
        }
        else {
            ground.push({ text: '─', dimColor: true });
        }
    }
    const label = props.isWorking ? status(live) : props.isHigh ? [glyph(live), { text: ' Time to /compact' }] : status(live);
    const figures = [props.usage, props.cost, props.limit === null ? null : `${props.limit.label} ${props.limit.percent}%`];
    const todo = todoChip(props);
    const side = [
        label,
        [{ text: figures.filter(part => part !== null).join(' · ') || 'No reading yet', dimColor: true }],
        [percentText(props), { text: ' used', dimColor: true }, ...(todo === null ? [] : [{ text: '   ' }, ...todo])],
    ];
    const rows = [
        [{ text: ' '.repeat(x) }, ...head, { text: ' '.repeat(track - x - SPRITE_WIDTH) }],
        [{ text: ' '.repeat(x) }, ...body, { text: ' '.repeat(track - x - SPRITE_WIDTH) }],
        ground,
    ];
    return rows.map((row, i) => (stats > 0 ? [...row, { text: '  ' }, ...fit(side[i] ?? [], stats)] : row));
}
// ── Peek: two rows, Clawd peeking over the prompt beside a line of chips ───────
function peek(live, columns) {
    const { props } = live;
    const width = Math.max(10, columns - SPRITE_WIDTH - 3);
    const [head, body] = clawd(live, false);
    const sep = { text: ' │ ', dimColor: true };
    const where = place(props);
    const now = status(live);
    const top = where.length === 0
        ? now
        : [...fit(now, Math.max(0, width - textOf(where).length - 2)), { text: '  ' }, ...where];
    const chips = [
        [{ text: 'ctx ', dimColor: true }, ...bar(props.percent, 10, props.isHigh ? RED : ORANGE), { text: ' ' }, percentText(props)],
        ...(props.limit === null
            ? []
            : [[{ text: `${props.limit.label} `, dimColor: true }, { text: `${props.limit.percent}%`, color: props.limit.percent >= 80 ? RED : SKY }]]),
        ...(props.cost === null ? [] : [[{ text: props.cost }]]),
        ...(props.elapsedMs === null ? [] : [[{ text: `◷ ${clock(elapsed(live))}`, dimColor: true }]]),
        ...(todoChip(props) === null ? [] : [todoChip(props) ?? []]),
    ];
    const bottom = chips.flatMap((chip, i) => (i === 0 ? chip : [sep, ...chip]));
    return [
        [{ text: ' ' }, ...head, { text: '  ' }, ...fit(top, width)],
        [{ text: ' ' }, ...body, { text: '  ' }, ...fit(bottom, width)],
    ];
}
// ── Clawd ──────────────────────────────────────────────────────────────────────
// His three rows for this tick: head, body, feet, each SPRITE_WIDTH cells.
function clawd(live, isWalking) {
    const { props, tick } = live;
    const isPetted = tick < live.heartUntil;
    const isCheering = tick < live.cheerUntil;
    const isFlinching = tick < live.oopsUntil;
    const isAsleep = isNapping(live) && !isPetted;
    const isBusy = props.isWorking || isWalking || isPetted || isCheering;
    const isBlinking = !isBusy && tick % 42 >= 40;
    const isReading = props.isWorking && props.activity !== null && /^(Reading|Searching)/.test(props.activity);
    const eyes = isFlinching ? 'wide' : isAsleep || isBlinking ? 'closed' : isReading ? 'glance' : 'open';
    const mark = isPetted
        ? { text: '♥', color: PINK }
        : isFlinching
            ? { text: '!', color: RED, bold: true }
            : isCheering
                ? { text: tick % 4 < 2 ? '✦' : '✧', color: GOLD }
                : isAsleep
                    ? { text: tick % 16 < 8 ? 'z' : 'Z', dimColor: true }
                    : props.isHigh && tick % 10 < 6
                        ? { text: '°', color: SKY }
                        : null;
    const head = [...HEADS[eyes]].map((cell, i) => {
        if (i === 8 && mark !== null) {
            return mark;
        }
        if (EYE_CELLS[eyes].includes(i)) {
            return { text: cell, color: ORANGE, backgroundColor: EYE };
        }
        return cell === ' ' ? { text: ' ' } : { text: cell, color: ORANGE };
    });
    const waves = isCheering ? tick % 2 === 1 : isBusy && Math.floor(tick / 2) % 2 === 1;
    const body = [...(waves ? ARMS_DOWN : ARMS_UP)].map((cell) => ({ text: cell, color: ORANGE }));
    const step = isWalking || isCheering ? tick % 2 : 0;
    const feet = [...(FEET[step] ?? '')].map((cell) => (cell === ' ' ? { text: ' ' } : { text: cell, color: ORANGE }));
    return [head, body, feet];
}
function isNapping(live) {
    const { props } = live;
    const idle = props.idleMs === null ? null : props.idleMs + (live.tick - live.propsTick) * TICK_MS;
    return !props.isWorking && idle !== null && idle >= NAP_AFTER_MS;
}
// ── Shared pieces ──────────────────────────────────────────────────────────────
function glyph(live) {
    return { text: live.props.isWorking ? (SPINNER[live.tick % SPINNER.length] ?? '✻') : '✻', color: ORANGE };
}
// What Claude is up to, or what happened last.
function status(live) {
    const { props, tick } = live;
    if (props.isWorking) {
        const verb = VERBS[Math.floor((tick * TICK_MS) / 3000) % VERBS.length] ?? 'Clauding';
        return [glyph(live), { text: ` ${props.activity ?? `${verb}…`}` }];
    }
    if (isNapping(live)) {
        return [{ text: '☾', color: SKY }, { text: ' Clawd is napping until your next prompt', dimColor: true }];
    }
    if (props.todos !== null && props.todos.done < props.todos.total && props.todos.current !== null) {
        return [glyph(live), { text: ` Next up: ${props.todos.current}` }];
    }
    if (props.lastTurn !== null) {
        return [glyph(live), { text: ` ${props.lastTurn}`, dimColor: true }];
    }
    return [glyph(live), { text: ' Ready when you are', dimColor: true }];
}
function place(props) {
    if (props.place === null) {
        return [];
    }
    const dirty = props.dirty === null ? [] : props.dirty === 0 ? [{ text: ' ✓', color: GREEN }] : [{ text: ` ●${props.dirty}`, color: AMBER }];
    return [{ text: props.place }, ...dirty];
}
function todoChip(props) {
    if (props.todos === null) {
        return null;
    }
    const isDone = props.todos.done === props.todos.total;
    return [{ text: isDone ? '☑' : '☐', color: isDone ? GREEN : ORANGE }, { text: ` ${props.todos.done}/${props.todos.total}` }];
}
function percentText(props) {
    return props.percent === null
        ? { text: '–', dimColor: true }
        : { text: `${props.percent}%`, bold: true, color: props.isHigh ? RED : ORANGE };
}
function bar(percent, width, color) {
    const filled = percent === null ? 0 : Math.round((Math.min(100, Math.max(0, percent)) / 100) * width);
    return [
        { text: '━'.repeat(filled), color },
        { text: '─'.repeat(width - filled), dimColor: true },
    ];
}
function elapsed(live) {
    return (live.props.elapsedMs ?? 0) + (live.tick - live.propsTick) * TICK_MS;
}
function clock(ms) {
    const minutes = Math.floor(ms / 60_000);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
function plain(line) {
    return line.map(segment => segment.text).join('');
}
function textOf(line) {
    return [...plain(line)];
}
// Cuts or pads a line of segments to exactly `width` cells.
function fit(line, width) {
    const out = [];
    let room = width;
    for (const segment of line) {
        const text = [...segment.text].slice(0, room).join('');
        room -= [...text].length;
        if (text !== '') {
            out.push({ ...segment, text });
        }
    }
    return room > 0 ? [...out, { text: ' '.repeat(room) }] : out;
}
// Joins neighbours drawn alike, so a row is a handful of Text runs, not one per cell.
function merge(line) {
    const out = [];
    for (const segment of line) {
        const last = out[out.length - 1];
        if (segment.text === '') {
            continue;
        }
        if (last !== undefined && sameStyle(last, segment)) {
            out[out.length - 1] = { ...last, text: last.text + segment.text };
        }
        else {
            out.push(segment);
        }
    }
    return out;
}
function sameStyle(a, b) {
    return a.color === b.color && a.backgroundColor === b.backgroundColor && a.bold === b.bold && a.dimColor === b.dimColor;
}
