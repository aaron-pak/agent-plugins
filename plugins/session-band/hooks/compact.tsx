import type { Elements, RenderElement } from 'claude-code'

import { moodOf } from './hearth/desk'
import type { BandProps as HearthProps } from './hearth/types'
import { ACCENT, CELLS as SEG_CELLS, DIM, SPACE, cutAt, firstFit, happeningForms } from './hearth/words'
import type { Line, Row as Segs } from './hearth/words'
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

/** His head always takes the cells it takes with his arms up, so the words never move (but for Apple's nap; see headCells). */
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
  const room = columns - headCells(face, props.isAppleTerminal)
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
  // His desktop's mood, read the same way: the cheer, the nap and the flinch as the desktop draws them.
  const mood = moodOf(props)
  const face: Face = mood.isCheer ? 'cheer' : mood.mode === 'nap' ? 'nap' : mood.isFlinch ? 'shut' : 'rest'
  const percent: Segs[number] =
    props.percent === null ? { text: '–' } : props.isHigh ? { text: `${Math.round(props.percent)}%`, color: ACCENT, bold: true } : { text: `${Math.round(props.percent)}%` }
  const room = columns - headCells(face, props.isAppleTerminal)
  // The words fit the room the percent alone leaves them, and "context 42%" shows where what they
  // leave holds it: a wider band never says less, as on the beach.
  const isFigured = room - GAP - SEG_CELLS.row([percent]) >= WORDS_LEAST
  const lineRoom = isFigured ? room - GAP - SEG_CELLS.row([percent]) : room
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
    isLanding: mood.isCheer,
  }
  const line = cutAt(firstFit(happeningForms(said), lineRoom, SEG_CELLS), lineRoom)
  const long: Segs = [{ text: 'context', color: DIM }, SPACE, percent]
  const figure = !isFigured ? [] : room - lineCells(line) - GAP >= SEG_CELLS.row(long) ? long : [percent]
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
      {figure.length === 0 ? null : <Text>{draw(figure)}</Text>}
    </Box>
  )
}

/** The cells a fitted line of the hearth's takes as the row draws it. */
function lineCells(line: Line): number {
  const squeezed = line.squeeze === undefined ? 0 : (line.squeezeWidth ?? SEG_CELLS.row(line.squeeze)) + SEG_CELLS.row(line.tail ?? [])

  return SEG_CELLS.row(line.left) + squeezed + (line.right.length === 0 ? 0 : GAP + SEG_CELLS.row(line.right))
}

/**
 * The cells his head and the gap after it take: one more for his nap in Apple's Terminal, whose
 * head fills all nine cells, so the z gets a cell of its own.
 */
function headCells(face: Face, isApple: boolean): number {
  return HEAD_CELLS + HEAD_GAP + (isApple && face === 'nap' ? 1 : 0)
}

/** His head row, from his own cells, as wide with his arms down as up; asleep, a dim z in the cell his arm would raise into. */
function head(el: Terminal, face: Face, isApple: boolean): RenderElement {
  const [sprite = []] = isApple ? applePose(FACES[face]) : pose(FACES[face])
  const row = face !== 'nap' ? sprite : isApple ? [...sprite, { ch: 'z' }] : [...sprite.slice(0, HEAD_CELLS - 1), { ch: 'z' }]
  const { Box, Text } = el

  return (
    <Box flexShrink={0} width={headCells(face, isApple)}>
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
