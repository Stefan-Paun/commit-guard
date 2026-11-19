// Audit log: one JSON line per decision of the hook, kept locally for `waechter report`.
// Only fields from an allow list are written (time, decision, rule, repo name, kind of command),
// never the command itself, file contents, reasons or secret values. Writing never throws.
import { appendFileSync, mkdirSync, statSync, renameSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const AUDIT_FILE = 'audit.jsonl'
export const GENERATIONS = 3 // audit.jsonl.1 … .3 after rotation
export const DEFAULT_MAX_BYTES = 1000000

/** Allowed fields, in this order. Anything else never reaches the file. */
export const FIELDS = ['zeit', 'entscheidung', 'regel', 'repo', 'befehl']
export const DECISIONS = { deny: 'geblockt', ask: 'gewarnt', allow: 'erlaubt' }
export const RULES = new Set([
  'geheimnis', 'private-email', 'telefonnummer', 'privater-pfad', 'identitaet', 'diff-zu-gross',
  'all-mirror', 'wildcard-refspec', 'gesperrter-branch', 'force-push', 'push-unlesbar', 'push-identitaet', 'immer-fragen',
  'schreibpruefung', 'verstecktes-git', 'unklarer-befehl', 'pruefung-fehlgeschlagen', 'keine', 'sonstiges',
])
export const KINDS = new Set(['git push', 'git commit', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'anderes Programm', 'unklar', 'hook', 'sonstiges'])
export const NO_REPO = '(kein Repo)'
const LIMITS = { zeit: 40, entscheidung: 12, regel: 40, repo: 120, befehl: 30 }
const FULL_PATH_LIMIT = 400

const expandHome = p => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p)

/** Folder of the log: config.auditDir, else $XDG_DATA_HOME/waechter, else ~/.local/share/waechter. */
export function auditDir(config) {
  if (typeof config?.auditDir === 'string' && config.auditDir.trim()) return expandHome(config.auditDir.trim())
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'waechter')
}

export const auditFile = config => join(auditDir(config), AUDIT_FILE)

/** Control characters out, length capped. */
export function clean(value, max) {
  // also bidi and zero-width marks, which could reorder report lines on screen
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '?').slice(0, max)
}

/** Builds an entry from the allow list only. Unknown decisions give null; unknown rules/kinds become 'sonstiges'. */
export function makeEntry({ decision, rule, kind, repo, now = new Date() }, config = {}) {
  const entscheidung = DECISIONS[decision]
  if (!entscheidung) return null
  return {
    zeit: clean(now.toISOString(), LIMITS.zeit),
    entscheidung,
    regel: RULES.has(rule) ? rule : decision === 'allow' ? 'keine' : 'sonstiges',
    repo: clean(repo || NO_REPO, config.auditFullPath ? FULL_PATH_LIMIT : LIMITS.repo),
    befehl: KINDS.has(kind) ? kind : 'sonstiges',
  }
}

const maxBytes = config => {
  const n = Number(config?.auditMaxBytes)
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_MAX_BYTES
}

/** audit.jsonl -> .1 -> .2 -> .3 (the oldest falls out) once the next line would exceed the limit. */
function rotate(file, incoming, limit) {
  const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
  if (size === 0 || size + incoming <= limit) return
  for (let i = GENERATIONS; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`
    try { renameSync(from, `${file}.${i}`) } catch { /* missing generation or a parallel rotation: fine */ }
  }
}

let reported = false
/** Tells once (per log folder, via a marker in the temp folder) that the log cannot be written. */
function reportOnce(dir, error, markerDir = tmpdir()) {
  if (reported) return
  reported = true
  const marker = join(markerDir, `waechter-audit-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}.gemeldet`)
  try {
    writeFileSync(marker, '', { mode: 0o600, flag: 'wx' }) // never follows a planted link
  } catch (e) {
    if (e?.code === 'EEXIST') return // already told
  }
  try {
    process.stderr.write(`waechter: Protokoll in ${dir} nicht beschreibbar (${error?.code ?? 'Fehler'}); der Hook prüft trotzdem weiter. Abschalten mit "auditLog": false.\n`)
  } catch { /* stderr closed */ }
}

/** Appends one entry. Returns true when written; errors are swallowed (and reported once). */
export function writeEntry(entry, config = {}, { markerDir } = {}) {
  if (!entry || config.auditLog === false) return false
  const dir = auditDir(config)
  try {
    const line = JSON.stringify(Object.fromEntries(FIELDS.map(f => [f, entry[f]]))) + '\n'
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32' && (statSync(dir).mode & 0o077)) chmodSync(dir, 0o700)
    const file = join(dir, AUDIT_FILE)
    rotate(file, Buffer.byteLength(line), maxBytes(config))
    // one write with O_APPEND: lines of parallel hooks do not interleave
    appendFileSync(file, line, { mode: 0o600 })
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077)) chmodSync(file, 0o600)
    return true
  } catch (e) {
    reportOnce(dir, e, markerDir)
    return false
  }
}

const VALUES = new Set(Object.values(DECISIONS))
// only times as written by makeEntry (years 2000-2999): an absurd date could make the report loop for ages
const ISO = /^2\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
function valid(e) {
  return e && typeof e === 'object' && !Array.isArray(e) &&
    typeof e.zeit === 'string' && ISO.test(e.zeit) && !Number.isNaN(Date.parse(e.zeit)) &&
    VALUES.has(e.entscheidung) && typeof e.regel === 'string' && typeof e.repo === 'string' && typeof e.befehl === 'string'
}

/** All generations, oldest first. Broken lines are skipped and counted. */
export function readEntries(config = {}) {
  const file = auditFile(config)
  const entries = []
  let broken = 0
  for (const name of [...Array.from({ length: GENERATIONS }, (_, i) => `${file}.${GENERATIONS - i}`), file]) {
    let text
    try { text = readFileSync(name, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch { broken++; continue }
      if (!valid(e)) { broken++; continue }
      entries.push(Object.fromEntries(FIELDS.map(f => [f, clean(e[f], f === 'repo' ? FULL_PATH_LIMIT : LIMITS[f])])))
    }
  }
  return { entries, broken }
}

/** Moves the log (all generations) aside into backup files instead of deleting it. Returns the new names. */
export function clearLog(config = {}, now = new Date()) {
  const file = auditFile(config)
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const moved = []
  for (const name of [file, ...Array.from({ length: GENERATIONS }, (_, i) => `${file}.${i + 1}`)]) {
    if (!existsSync(name)) continue
    let target = `${name}.sicherung-${stamp}`
    for (let i = 2; existsSync(target); i++) target = `${name}.sicherung-${stamp}-${i}` // never replace an older backup
    renameSync(name, target)
    moved.push(target)
  }
  return moved
}
