import type { ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'

import type { ClawdProps } from '../types'

// Clawd walks a track that fills as the context window does: the line behind
// him is context used, the line ahead is room left. He scuttles while Claude
// works, blinks when idle, sweats past the warning line and loves being clicked.

type Live = { props: ClawdProps; tick: number; x: number; heartUntil: number }
type State = { live: Live; frame: string }
type Segment = { text: string; color?: string; backgroundColor?: string; bold?: boolean; dimColor?: boolean }

const TICK_MS = 120
const ORANGE = '#D77757'
const RED = '#E5484D'
const PINK = '#F27BA8'
const SWEAT = '#7FB8E6'
const EYE = '#000000'

const SPRITE_WIDTH = 9
const CENTER = 4
const HEAD = ' ▐▛███▜▌ '
const EYES = [2, 6]
const ARMS_UP = '▝▜█████▛▘'
const ARMS_DOWN = '▗▜█████▛▖'
const FEET = ['  ▘▘ ▝▝  ', '  ▝▝ ▘▘  ']

// Claude Code's own spinner glyphs, out and back.
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const VERBS = ['Scuttling', 'Clauding', 'Pinching tokens', 'Sidestepping', 'Tidepooling', 'Clawing through it']

const Clawd: ClientModule<ClawdProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    state = { live: { props, tick: 0, x: 0, heartUntil: -1 }, frame: '' }
    surface.setState(state)
    surface.every(TICK_MS, () => advance(surface))
    surface.onPointer(event => pet(surface, event))
  }
  state.live.props = props

  return (
    <Box flexDirection="column">
      {compose(state.live, widthOf(surface)).map(row => (
        <Text wrap="truncate-end">
          {row.map(({ text, ...style }) => (
            <Text {...style}>{text}</Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

export default Clawd

function advance(surface: ClientSurface<State>): void {
  const state = surface.state
  if (state === undefined) {
    return
  }

  const live = state.live
  const { trackWidth } = layout(widthOf(surface))
  const target = targetX(live.props.percent, trackWidth)
  live.tick += 1
  live.x += Math.sign(target - live.x)

  repaint(surface, state)
}

function pet(surface: ClientSurface<State>, event: ClientPointerEvent): void {
  const state = surface.state
  const isOnClawd = state !== undefined && event.y <= 2 && event.x >= state.live.x && event.x < state.live.x + SPRITE_WIDTH
  if (event.type !== 'down' || !isOnClawd) {
    return
  }

  state.live.heartUntil = state.live.tick + 14
  repaint(surface, state)
}

// Only a frame that looks different is drawn again, so an idle Clawd costs a redraw per blink.
function repaint(surface: ClientSurface<State>, state: State): void {
  const frame = JSON.stringify(compose(state.live, widthOf(surface)))
  if (frame !== state.frame) {
    surface.setState({ live: state.live, frame })
  }
}

function widthOf(surface: ClientSurface<State>): number {
  return surface.columns > 0 ? surface.columns : (surface.state?.live.props.columns ?? 80)
}

function layout(columns: number): { trackWidth: number; statsWidth: number } {
  const statsWidth = columns >= 64 ? 24 : columns >= 36 ? 12 : 0
  const gap = statsWidth > 0 ? 2 : 0

  return { trackWidth: Math.max(SPRITE_WIDTH, columns - statsWidth - gap), statsWidth }
}

function targetX(percent: number | null, trackWidth: number): number {
  const room = trackWidth - SPRITE_WIDTH

  return Math.round((Math.min(100, Math.max(0, percent ?? 0)) / 100) * room)
}

function compose(live: Live, columns: number): Segment[][] {
  const { props, tick } = live
  const { trackWidth, statsWidth } = layout(columns)
  const x = Math.min(live.x, trackWidth - SPRITE_WIDTH)
  const isWalking = x !== targetX(props.percent, trackWidth)
  const isPetted = tick < live.heartUntil
  const isBusy = props.isWorking || isWalking || isPetted
  const isBlinking = !isBusy && tick % 42 >= 40

  const head = sprite(HEAD, (glyph, i) => {
    if (i === 8 && isPetted) {
      return { text: '♥', color: PINK }
    }
    if (i === 8 && props.isHigh && tick % 10 < 6) {
      return { text: '°', color: SWEAT }
    }
    if (EYES.includes(i)) {
      return isBlinking ? { text: '█', color: ORANGE } : { text: glyph, color: ORANGE, backgroundColor: EYE }
    }

    return glyph === ' ' ? { text: ' ' } : { text: glyph, color: ORANGE }
  })
  const arms = isBusy && Math.floor(tick / 2) % 2 === 1 ? ARMS_DOWN : ARMS_UP
  const body = sprite(arms, glyph => ({ text: glyph, color: ORANGE }))
  const feet = FEET[isWalking ? tick % 2 : 0] ?? ''

  const track: Segment[] = []
  for (let column = 0; column < trackWidth; column++) {
    const foot = feet[column - x]
    if (foot !== undefined && foot !== ' ') {
      track.push({ text: foot, color: ORANGE })
    } else if (props.percent !== null && column <= x + CENTER) {
      track.push({ text: '━', color: ORANGE })
    } else {
      track.push({ text: '─', dimColor: true })
    }
  }

  const stats = statLines(live)
  const rows: Segment[][] = [
    [{ text: ' '.repeat(x) }, ...head, { text: ' '.repeat(trackWidth - x - SPRITE_WIDTH) }],
    [{ text: ' '.repeat(x) }, ...body, { text: ' '.repeat(trackWidth - x - SPRITE_WIDTH) }],
    track,
  ]

  return rows.map((row, i) => merge(statsWidth > 0 ? [...row, { text: '  ' }, ...fit(stats[i] ?? [], statsWidth)] : row))
}

function statLines({ props, tick }: Live): Segment[][] {
  const glyph = props.isWorking ? (SPINNER[tick % SPINNER.length] ?? '✻') : '✻'
  const verb = VERBS[Math.floor((tick * TICK_MS) / 3000) % VERBS.length] ?? 'Clauding'
  const label = props.isWorking ? `${verb}…` : props.isHigh ? 'Time to /compact' : 'Context'
  const percent: Segment =
    props.percent === null
      ? { text: '–', dimColor: true }
      : { text: `${props.percent}%`, bold: true, color: props.isHigh ? RED : ORANGE }

  return [
    [{ text: glyph, color: ORANGE }, { text: ` ${label}` }],
    [{ text: props.cost === null ? props.usage : `${props.usage} · ${props.cost}`, dimColor: true }],
    [percent, { text: ' used', dimColor: true }],
  ]
}

function sprite(row: string, paint: (glyph: string, i: number) => Segment): Segment[] {
  return [...row].map((glyph, i) => paint(glyph, i))
}

// Cuts or pads a line of segments to exactly `width` cells.
function fit(line: Segment[], width: number): Segment[] {
  const out: Segment[] = []
  let room = width
  for (const segment of line) {
    const text = [...segment.text].slice(0, room).join('')
    room -= [...text].length
    if (text !== '') {
      out.push({ ...segment, text })
    }
  }

  return room > 0 ? [...out, { text: ' '.repeat(room) }] : out
}

// Joins neighbours drawn alike, so a row is a handful of Text runs, not one per cell.
function merge(row: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const segment of row) {
    const last = out[out.length - 1]
    if (segment.text === '') {
      continue
    }
    if (last !== undefined && sameStyle(last, segment)) {
      out[out.length - 1] = { ...last, text: last.text + segment.text }
    } else {
      out.push(segment)
    }
  }

  return out
}

function sameStyle(a: Segment, b: Segment): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    a.bold === b.bold &&
    a.dimColor === b.dimColor
  )
}
