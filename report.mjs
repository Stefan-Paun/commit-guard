// `waechter report`: summary of the audit log (sums per decision, rule and repo, days, last cases).
import { readEntries, clearLog, auditFile, DECISIONS } from './audit.mjs'

const DAY = 86400000
const ORDER = Object.values(DECISIONS) // geblockt, gewarnt, erlaubt
export const LAST = 10
export const MAX_DAYS_SHOWN = 31
const BAR = 30
// a rule is an exception candidate when it warned at least this often and makes up a quarter of all warnings
export const OFTEN = 5

const pad2 = n => String(n).padStart(2, '0')
/** Local calendar day YYYY-MM-DD. */
export const dayOf = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const timeOf = d => `${dayOf(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`

const count = (list, key) => {
  const out = Object.create(null) // repo names like "constructor" or "__proto__" are plain keys
  for (const e of list) out[e[key]] = (out[e[key]] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}
const repoMatches = (repo, want) => {
  const w = want.toLowerCase()
  const r = repo.toLowerCase()
  return r === w || r.split(/[\\/]/).pop() === w
}

/**
 * Summary of the entries of the last `tage` days (0 = all), optionally for one repo.
 * Returns plain data; the formats below only render it.
 */
export function summarize(entries, { tage = 7, repo, now = new Date(), broken = 0 } = {}) {
  const days = Number.isFinite(tage) && tage > 0 ? Math.floor(tage) : 0
  // whole calendar days: today plus the days before it
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days ? days - 1 : 0))
  const list = entries.filter(e => {
    const t = new Date(e.zeit)
    if (days && (t < start || t > now)) return false
    return !repo || repoMatches(e.repo, repo)
  })
  const decisions = Object.fromEntries(ORDER.map(d => [d, list.filter(e => e.entscheidung === d).length]))

  // per day: the shown period (at most MAX_DAYS_SHOWN days, newest last)
  let first = start
  if (!days) first = list.length ? new Date(list.reduce((m, e) => Math.min(m, Date.parse(e.zeit)), Infinity)) : now
  const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (MAX_DAYS_SHOWN - 1))
  const from = first < earliest ? earliest : first
  const shown = []
  for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= now; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) shown.push(dayOf(d))
  const perDay = new Map(shown.map(t => [t, Object.fromEntries(ORDER.map(d => [d, 0]))]))
  for (const e of list) {
    const row = perDay.get(dayOf(new Date(e.zeit)))
    if (row) row[e.entscheidung]++
  }

  const warned = list.filter(e => e.entscheidung === 'gewarnt')
  const candidates = Object.entries(count(warned, 'regel'))
    .filter(([, n]) => n >= OFTEN && n * 4 >= warned.length)
    .map(([regel, anzahl]) => ({ regel, anzahl }))

  return {
    zeitraum: { tage: days || 'alle', von: days ? dayOf(start) : list.length ? dayOf(first) : null, bis: dayOf(now) },
    repo: repo || null,
    faelle: list.length,
    entscheidungen: decisions,
    regeln: count(list, 'regel'),
    repos: count(list, 'repo'),
    tage: [...perDay].map(([tag, n]) => ({ tag, ...n })),
    letzte: list.slice(-LAST).reverse(),
    ausnahmeKandidaten: candidates,
    kaputteZeilen: broken,
  }
}

const header = s => `waechter-Bericht: ${s.zeitraum.tage === 'alle' ? 'gesamter Zeitraum' : `letzte ${s.zeitraum.tage} Tage`}` +
  ` (${s.repo ? `Repo ${s.repo}` : 'alle Repos'})`
const decisionLine = s => ORDER.map(d => `${d} ${s.entscheidungen[d]}`).join(', ')
const total = row => ORDER.reduce((n, d) => n + row[d], 0)
function bar(row, max) {
  if (!max) return ''
  // blocked '#', warned '+', allowed '.'; at least one sign for any case
  const signs = { geblockt: '#', gewarnt: '+', erlaubt: '.' }
  return ORDER.map(d => signs[d].repeat(row[d] ? Math.max(1, Math.round((row[d] / max) * BAR)) : 0)).join('')
}
const hint = c => `${c.regel} (${c.anzahl}× gewarnt): Kandidat für eine Ausnahme oder engere Einstellung`

export function formatText(s) {
  const out = [header(s), `Fälle: ${s.faelle} (${decisionLine(s)})`]
  if (!s.faelle) out.push('Keine Einträge im Zeitraum.')
  const table = (title, obj) => {
    const keys = Object.keys(obj)
    if (!keys.length) return
    const w = Math.max(...keys.map(k => k.length))
    out.push('', `${title}:`, ...keys.map(k => `  ${k.padEnd(w)}  ${obj[k]}`))
  }
  table('Nach Regel', s.regeln)
  table('Nach Repo', s.repos)
  if (s.faelle) {
    const max = Math.max(...s.tage.map(total))
    out.push('', 'Verlauf je Tag (# geblockt, + gewarnt, . erlaubt):',
      ...s.tage.map(r => `  ${r.tag}  ${String(total(r)).padStart(4)}  ${bar(r, max)}`.trimEnd()))
    out.push('', `Letzte ${s.letzte.length} Fälle:`,
      ...s.letzte.map(e => `  ${timeOf(new Date(e.zeit))}  ${e.entscheidung.padEnd(8)}  ${e.regel}  ${e.repo}  ${e.befehl}`))
  }
  if (s.ausnahmeKandidaten.length) out.push('', 'Warnt besonders oft:', ...s.ausnahmeKandidaten.map(c => `  ${hint(c)}`))
  if (s.kaputteZeilen) out.push('', `Übersprungene kaputte Zeilen: ${s.kaputteZeilen}`)
  return out.join('\n') + '\n'
}

const cell = v => String(v).replace(/[\\`*_<>[\]|#!~&]/g, m => `\\${m}`)

export function formatMarkdown(s) {
  const out = [`## ${cell(header(s))}`, '', `**Fälle:** ${s.faelle} (${decisionLine(s)})`]
  const table = (title, head, rows) => {
    if (!rows.length) return
    out.push('', `### ${title}`, '', `| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`))
  }
  table('Nach Regel', ['Regel', 'Fälle'], Object.entries(s.regeln))
  table('Nach Repo', ['Repo', 'Fälle'], Object.entries(s.repos))
  if (s.faelle) {
    table('Verlauf je Tag', ['Tag', ...ORDER], s.tage.map(r => [r.tag, ...ORDER.map(d => r[d])]))
    table(`Letzte ${s.letzte.length} Fälle`, ['Zeit', 'Entscheidung', 'Regel', 'Repo', 'Befehl'],
      s.letzte.map(e => [timeOf(new Date(e.zeit)), e.entscheidung, e.regel, e.repo, e.befehl]))
  }
  if (s.ausnahmeKandidaten.length) out.push('', '### Warnt besonders oft', '', ...s.ausnahmeKandidaten.map(c => `- ${cell(hint(c))}`))
  if (s.kaputteZeilen) out.push('', `Übersprungene kaputte Zeilen: ${s.kaputteZeilen}`)
  return out.join('\n') + '\n'
}

export const USAGE = `Aufruf: waechter report [--tage N] [--repo NAME] [--format text|json|md]
       waechter report --leeren
  --tage N     nur die letzten N Tage (Standard 7, 0 = alles)
  --repo NAME  nur dieses Repo (Ordnername oder voller Pfad)
  --format     text (Standard), json oder md
  --leeren     Protokoll in eine Sicherungsdatei verschieben (nichts wird gelöscht)
`

/** Parses the report arguments; returns { options } or { error }. */
export function parseArgs(argv) {
  const o = { tage: 7, repo: undefined, format: 'text', leeren: false, hilfe: false }
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]
    let value
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) { value = a.slice(eq + 1); a = a.slice(0, eq) }
    const next = () => {
      if (value !== undefined) return value
      if (i + 1 >= argv.length) return undefined
      return argv[++i]
    }
    if (a === '--tage') {
      const v = next()
      if (v === undefined || !/^\d+$/.test(v)) return { error: '--tage braucht eine ganze Zahl ≥ 0' }
      o.tage = Number(v)
    } else if (a === '--repo') {
      const v = next()
      if (!v) return { error: '--repo braucht einen Namen' }
      o.repo = v
    } else if (a === '--format') {
      const v = next()
      if (!['text', 'json', 'md'].includes(v)) return { error: '--format ist text, json oder md' }
      o.format = v
    } else if (a === '--leeren' && value === undefined) o.leeren = true
    else if ((a === '--hilfe' || a === '--help' || a === '-h') && value === undefined) o.hilfe = true
    else return { error: `unbekanntes Argument: ${argv[i]}` }
  }
  return { options: o }
}

/** CLI entry. Returns the exit code; output goes through `out`/`err` (default stdout/stderr). */
export function runReport(argv, { loadConfig, config, now = new Date(), out = s => process.stdout.write(s), err = s => process.stderr.write(s) } = {}) {
  const parsed = parseArgs(argv)
  if (parsed.error) { err(`waechter report: ${parsed.error}\n${USAGE}`); return 2 }
  const o = parsed.options
  if (o.hilfe) { out(USAGE); return 0 }
  let cfg
  try { cfg = config ?? loadConfig() } catch (e) { err(`waechter report: Konfiguration nicht lesbar (${e.message})\n`); return 1 }
  if (o.leeren) {
    let moved
    try { moved = clearLog(cfg, now) } catch (e) { err(`waechter report: Protokoll konnte nicht verschoben werden (${e.code ?? e.message})\n`); return 1 }
    out(moved.length ? `Protokoll verschoben nach:\n${moved.map(m => `  ${m}`).join('\n')}\n` : `Kein Protokoll vorhanden (${auditFile(cfg)}).\n`)
    return 0
  }
  const { entries, broken } = readEntries(cfg)
  const s = summarize(entries, { tage: o.tage, repo: o.repo, now, broken })
  if (o.format === 'json') out(JSON.stringify(s, null, 2) + '\n')
  else if (o.format === 'md') out(formatMarkdown(s))
  else {
    out(formatText(s))
    if (cfg.auditLog === false) out('Hinweis: "auditLog" ist false, es wird nichts protokolliert.\n')
  }
  return 0
}
