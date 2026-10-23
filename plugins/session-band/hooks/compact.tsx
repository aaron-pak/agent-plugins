import type { Elements, RenderElement } from 'claude-code'

import { cells, cut } from './clawd'
import { NAP_AFTER_MS } from './facts'
import { CHEER_FOR_MS, FLINCH_MS } from './hearth/desk'
import type { BandProps as HearthProps } from './hearth/types'
import { ACCENT, DIM, SPACE, firstFit, happeningForms, squeezeCut, squeezeRoom } from './hearth/words'
import type { Line, Measure, Row as Segs } from './hearth/words'
import { linesFor, style } from './tide/desk'
import { CELLS, fitLine } from './tide/fit'
import { applePose, pose } from './tide/sprite'
import type { Pose, Row } from './tide/sprite'
import type { BandProps as TideProps, Words } from './tide/types'

// The band in one row on the terminal: Clawd's head, what is happening, and how full the context is,
// each look in its own words. It is the band when the person keeps it to one row (/config's Band
// size), and whenever Claude Code leaves it fewer rows than three (a tall draft in the prompt). The
// hooks module draws it: no surface module, so a band kept to one row never loads one.

type Terminal = Elements['terminal']

/** His head always takes the cells it takes with his arms up, so the words never move. */
const HEAD_CELLS = 9
/** The cell between his head and the words. */
const HEAD_GAP = 1
/** The cells before the figures at the right. */
const GAP = 2
/** Cells kept free at the band's right edge, as both looks keep them, should a host hold the last column back. */
const SLACK = 2

/** How he looks in the one row: at rest, arms up for a cheer, eyes shut (splashed, or a hiccup), or asleep with a z. */
type Face = 'rest' | 'cheer' | 'shut' | 'nap'

const FACES: Record<Face, Pose> = {
  rest: { eyes: 'open', arms: 'down', feet: 'both' },
  cheer: { eyes: 'open', arms: 'up', feet: 'both' },
  shut: { eyes: 'closed', arms: 'down', feet: 'both' },
  nap: { eyes: 'closed', arms: 'down', feet: 'both' },
}

/** The words below this many cells give the context's figure up, so the first line keeps its room. */
const WORDS_LEAST = 12

/** The beach's one row: its first line as the desktop picks it, and its context line at the right. */
export function tideRow(el: Terminal, props: TideProps, bodyColumns: number): RenderElement {
  const columns = Math.max(1, bodyColumns - SLACK)
  const [first = [], tide = []] = linesFor(props)
  const face: Face = first === props.words.cheer ? 'cheer' : first === props.words.nap ? 'nap' : first === props.words.splash ? 'shut' : 'rest'
  const room = columns - HEAD_CELLS - HEAD_GAP
  // How full the context is keeps at least its shortest form at the right: the first line fits the
  // room that leaves, and the context line then takes all it can of what the first line left.
  const least = wordsCells(tide[tide.length - 1] ?? [])
  const isFigured = least > 0 && room - GAP - least >= WORDS_LEAST
  const said = fitLine(first, isFigured ? room - GAP - least : room, CELLS)
  const rest = room - wordsCells(said) - GAP
  const figures = isFigured ? fitLine(tide, rest, CELLS) : []
  const shown = wordsCells(figures) <= rest ? figures : []
  const { Box, Text } = el

  return (
    <Box flexDirection="row" width={columns} height={1}>
      {head(el, face, props.isAppleTerminal)}
      <Text wrap="truncate-end">
        {said.map(piece => (
          <Text {...style(piece)}>{piece.text}</Text>
        ))}
      </Text>
      <Box flexGrow={1} />
      {shown.length === 0 ? null : (
        <Text wrap="truncate-end">
          {shown.map(piece => (
            <Text {...style(piece)}>{piece.text}</Text>
          ))}
        </Text>
      )}
    </Box>
  )
}

/** The hearth's one row: its third line (what is happening, and the tally), and the context's figure at the right. */
export function hearthRow(el: Terminal, props: HearthProps, bodyColumns: number): RenderElement {
  const columns = Math.max(1, bodyColumns - SLACK)
  const idle = props.idleMs ?? 0
  const isNap = !props.isWorking && props.idleMs !== null && idle >= NAP_AFTER_MS
  const isSeen = (ago: number | null) => props.shownForMs === null || (ago !== null && ago <= props.shownForMs)
  const isLanding = !props.isWorking && !isNap && props.lastTurn?.ending === 'answer' && idle < CHEER_FOR_MS && isSeen(props.idleMs)
  const isFlinch = props.isWorking && props.flinchAgoMs !== null && props.flinchAgoMs < FLINCH_MS && isSeen(props.flinchAgoMs)
  const face: Face = isLanding ? 'cheer' : isNap ? 'nap' : isFlinch ? 'shut' : 'rest'
  const figure: Segs = [
    { text: 'context', color: DIM },
    SPACE,
    props.percent === null ? { text: '–' } : props.isHigh ? { text: `${Math.round(props.percent)}%`, color: ACCENT, bold: true } : { text: `${Math.round(props.percent)}%` },
  ]
  const room = columns - HEAD_CELLS - HEAD_GAP
  const lineRoom = room - GAP - ROW_CELLS.row(figure)
  const isFigured = lineRoom >= WORDS_LEAST
  const said = {
    isWorking: props.isWorking,
    activity: props.activity,
    slip: props.slip,
    todos: props.todos,
    isHigh: props.isHigh,
    percent: props.percent,
    limit: props.limit,
    lastTurn: props.lastTurn,
    resetsAt: props.limit?.resetsAt ?? null,
    // While he cheers, the words say what finished; a warning waits for the cheer to end.
    isLanding,
  }
  const line = cutTo(firstFit(happeningForms(said), isFigured ? lineRoom : room, ROW_CELLS), isFigured ? lineRoom : room)
  const { Box, Text } = el
  const draw = (segs: Segs) => segs.map(({ text, ...look }) => <Text {...look}>{text}</Text>)

  return (
    <Box flexDirection="row" width={columns} height={1}>
      {head(el, face, props.isAppleTerminal)}
      {line.squeeze === undefined ? (
        <Text wrap="truncate-end">{draw(line.left)}</Text>
      ) : (
        <Box flexDirection="row" flexShrink={1}>
          <Text>{draw(line.left)}</Text>
          <Box flexShrink={1} overflow="hidden" width={line.squeezeWidth}>
            <Text wrap="truncate-end">{draw(line.squeeze)}</Text>
          </Box>
          <Text>{draw(line.tail ?? [])}</Text>
        </Box>
      )}
      {line.right.length === 0 ? null : (
        <Box flexShrink={0} marginLeft={GAP}>
          <Text>{draw(line.right)}</Text>
        </Box>
      )}
      <Box flexGrow={1} />
      {isFigured ? <Text>{draw(figure)}</Text> : null}
    </Box>
  )
}

/** His head row, from his own cells, as wide with his arms down as up; asleep, a dim z in the cell his arm would raise into. */
function head(el: Terminal, face: Face, isApple: boolean): RenderElement {
  const [sprite = []] = isApple ? applePose(FACES[face]) : pose(FACES[face])
  const row = face === 'nap' ? [...sprite.slice(0, HEAD_CELLS - 1), { ch: 'z' }] : sprite
  const { Box, Text } = el

  return (
    <Box flexShrink={0} width={HEAD_CELLS + HEAD_GAP}>
      <Text>
        {runs(row).map(({ text, color, bg }) => (
          <Text {...(color === undefined ? {} : { color })} {...(bg === undefined ? {} : { backgroundColor: bg })} {...(text === 'z' ? { dimColor: true } : {})}>
            {text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

// His cells joined where they are drawn alike, so the head is a few Text runs, not one per cell.
function runs(row: Row): Array<{ text: string; color?: string; bg?: string }> {
  const out: Array<{ text: string; color?: string; bg?: string }> = []
  for (const cell of row) {
    const color = cell.ch === ' ' ? undefined : cell.color
    const last = out[out.length - 1]
    if (last !== undefined && last.color === color && last.bg === cell.bg) {
      last.text += cell.ch
    } else {
      out.push({ text: cell.ch, ...(color === undefined ? {} : { color }), ...(cell.bg === undefined ? {} : { bg: cell.bg }) })
    }
  }

  return out
}

function wordsCells(words: Words): number {
  return words.reduce((sum, piece) => sum + CELLS.text(piece.text, piece.bold === true || piece.fitsAsBold === true), 0)
}

/** The hearth's lines measured in terminal cells, as its terminal band measures them. */
const ROW_CELLS: Measure = { row: segs => segs.reduce((sum, seg) => sum + cells(seg.text), 0), gap: GAP }

/**
 * A squeezed part that must be cut gets a box exactly as wide as what shows of it and Ink's
 * ellipsis, ending where the hearth's terminal band ends it (see its cutAt).
 */
function cutTo(line: Line, room: number): Line {
  if (line.squeeze === undefined) {
    return line
  }
  const left = squeezeRoom(line, room, ROW_CELLS)
  const text = line.squeeze.map(seg => seg.text).join('')
  if (cells(text) <= left) {
    return line
  }
  const kept = cut(text, left - 1)
  const neat = squeezeCut(line, text, kept)

  return { ...line, squeezeWidth: Math.max(1, cells(neat === '' ? kept : neat) + 1) }
}
