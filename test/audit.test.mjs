// Audit log and `waechter report`. Every log lives in a temp folder; the real home is never touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync, readdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, logDecision, DEFAULT_CONFIG } from '../waechter.mjs'
import { makeEntry, writeEntry, readEntries, clearLog, auditDir, auditFile, FIELDS, AUDIT_FILE, NO_REPO } from '../audit.mjs'
import { summarize, formatText, formatMarkdown, parseArgs, runReport, dayOf } from '../report.mjs'

for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_DIR', 'GIT_WORK_TREE']) delete process.env[k]

const root = mkdtempSync(join(tmpdir(), 'waechter-audit-'))
let n = 0
const freshDir = () => join(root, `log${++n}`)
const base = { ...DEFAULT_CONFIG, publicRepoPatterns: ['example/public'], blockedBranches: ['old'] }
const withLog = (extra = {}) => ({ ...base, auditDir: freshDir(), ...extra })
const lines = cfg => readFileSync(auditFile(cfg), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
// secret-shaped test values are put together at runtime only
const fakeKey = () => ['AK', 'IA', 'Q7W8E9R0', 'T1Y2U3I4'].join('') // no long run of one character: that counts as a placeholder
const fakeToken = () => ['gh', 'p_', 'z'.repeat(36)].join('')

function mk(remote, name = `repo${++n}`) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' })
  g('init', '-q', '-b', 'main')
  g('remote', 'add', 'origin', remote)
  g('config', 'user.name', 't'); g('config', 'user.email', 't@users.noreply.github.com'); g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  g('add', 'a.txt'); g('commit', '-q', '-m', 'init')
  g('branch', 'old')
  return { dir, g }
}
const PUBLIC = 'git@github.com:example/public.git'
const PRIVATE = 'git@github.com:example/private.git'
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd })
function hook(input, cfg) {
  const info = { seen: [] }
  const v = check(input, cfg, info)
  return { v, written: logDecision(v, info, cfg) }
}

// ---- writing

test('entry has exactly the allowed fields, values from fixed lists', () => {
  const e = makeEntry({ decision: 'deny', rule: 'gesperrter-branch', kind: 'git push', repo: 'r', now: new Date('2026-11-01T10:00:00Z') })
  assert.deepEqual(Object.keys(e), FIELDS)
  assert.deepEqual(e, { zeit: '2026-11-01T10:00:00.000Z', entscheidung: 'geblockt', regel: 'gesperrter-branch', repo: 'r', befehl: 'git push' })
  const odd = makeEntry({ decision: 'ask', rule: 'git push --force secret', kind: 'rm -rf /', repo: 'x\ny'.repeat(100) })
  assert.equal(odd.regel, 'sonstiges')
  assert.equal(odd.befehl, 'sonstiges')
  assert.ok(!odd.repo.includes('\n'))
  assert.ok(odd.repo.length <= 120)
  assert.equal(makeEntry({ decision: 'maybe' }), null)
  assert.equal(makeEntry({ decision: 'allow' }).regel, 'keine')
  assert.equal(makeEntry({ decision: 'ask' }).repo, NO_REPO)
})

test('writeEntry drops extra fields even if the caller passes them', () => {
  const cfg = withLog()
  const e = { ...makeEntry({ decision: 'ask', rule: 'geheimnis', kind: 'git commit', repo: 'r' }), befehlstext: 'git commit -m x', reason: 'r' }
  assert.equal(writeEntry(e, cfg), true)
  assert.deepEqual(Object.keys(lines(cfg)[0]), FIELDS)
})

test('a blocked commit with a secret in the command leaves no trace of it in the log', () => {
  const cfg = withLog()
  const { dir } = mk(PUBLIC, 'secret-repo')
  writeFileSync(join(dir, 'b.txt'), `key ${fakeKey()}\n`)
  execFileSync('git', ['-C', dir, 'add', 'b.txt'])
  const key = fakeKey()
  const token = fakeToken()
  const { v, written } = hook(bash(`git commit -m "${key}" && git push https://${token}@github.com/example/public.git old`, dir), cfg)
  assert.equal(v.decision, 'deny')
  assert.equal(written, 1)
  const raw = readFileSync(auditFile(cfg), 'utf8')
  for (const bad of [key, key.slice(0, 8), token, token.slice(0, 8), 'b.txt', '-m', 'AWS', v.reason, root]) assert.ok(!raw.includes(bad), `log contains ${bad}`)
  const [e] = lines(cfg)
  assert.deepEqual(Object.keys(e), FIELDS)
  assert.equal(e.entscheidung, 'geblockt')
  assert.equal(e.repo, 'secret-repo')
  assert.ok(['git commit', 'git push'].includes(e.befehl))
})

test('rules and kinds of real decisions', () => {
  const cfg = withLog()
  const pub = mk(PUBLIC, 'pub-repo')
  const priv = mk(PRIVATE, 'priv-repo')
  hook(bash('git push origin old', pub.dir), cfg)
  hook(bash('git push --all', pub.dir), cfg)
  writeFileSync(join(priv.dir, 'c.txt'), `k=${fakeKey()}\n`); priv.g('add', 'c.txt')
  hook(bash('git commit -m x', priv.dir), cfg)
  hook(bash('python3 -c "import os; os.system(\'git push\')"', priv.dir), cfg)
  hook(bash('eval "$X"', pub.dir), cfg)
  hook(bash('ls -la', pub.dir), cfg) // allowed and not git: nothing
  const got = lines(cfg).map(e => [e.entscheidung, e.regel, e.befehl, e.repo])
  assert.deepEqual(got, [
    ['geblockt', 'gesperrter-branch', 'git push', 'pub-repo'],
    ['geblockt', 'all-mirror', 'git push', 'pub-repo'],
    ['gewarnt', 'geheimnis', 'git commit', 'priv-repo'],
    ['gewarnt', 'verstecktes-git', 'anderes Programm', 'priv-repo'],
    ['geblockt', 'unklarer-befehl', 'unklar', 'pub-repo'],
  ])
})

test('allowed cases only with auditAllowed, full path only with auditFullPath', () => {
  const pub = mk(PUBLIC, 'allowed-repo')
  const off = withLog()
  assert.equal(hook(bash('git push origin main', pub.dir), off).written, 0)
  assert.equal(existsSync(auditFile(off)), false)
  const on = withLog({ auditAllowed: true })
  assert.equal(hook(bash('git push origin main', pub.dir), on).written, 1)
  assert.deepEqual(lines(on).map(e => [e.entscheidung, e.regel, e.repo]), [['erlaubt', 'keine', 'allowed-repo']])
  const full = withLog({ auditFullPath: true })
  hook(bash('git push origin old', pub.dir), full)
  const top = execFileSync('git', ['-C', pub.dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  assert.equal(lines(full)[0].repo, top)
})

test('write check entries name the tool, never the file or content', () => {
  const cfg = withLog({ writeCheck: 'blocken' })
  const pub = mk(PUBLIC, 'write-repo')
  const key = fakeKey()
  const { v } = hook({ tool_name: 'Write', tool_input: { file_path: join(pub.dir, 'conf.js'), content: `k='${key}'` }, cwd: pub.dir }, cfg)
  assert.equal(v.decision, 'deny')
  const raw = readFileSync(auditFile(cfg), 'utf8')
  assert.ok(!raw.includes(key) && !raw.includes('conf.js'))
  assert.deepEqual(lines(cfg).map(e => [e.regel, e.befehl, e.repo]), [['schreibpruefung', 'Write', 'write-repo']])
})

test('auditLog: false switches everything off', () => {
  const cfg = withLog({ auditLog: false, auditAllowed: true })
  const pub = mk(PUBLIC)
  assert.equal(hook(bash('git push origin old', pub.dir), cfg).written, 0)
  assert.equal(writeEntry(makeEntry({ decision: 'deny' }), cfg), false)
  assert.equal(existsSync(auditDir(cfg)), false)
})

test('unwritable log folder: the hook still decides correctly and nothing throws', () => {
  const file = join(root, `plain-file-${++n}`)
  writeFileSync(file, 'x')
  const cfg = { ...base, auditDir: join(file, 'sub') } // a folder below a file can never be created
  const pub = mk(PUBLIC)
  const { v, written } = hook(bash('git push origin old', pub.dir), cfg)
  assert.equal(v.decision, 'deny')
  assert.equal(written, 0)
  assert.equal(writeEntry(makeEntry({ decision: 'ask' }), cfg, { markerDir: root }), false)
  assert.equal(logDecision({ decision: 'ask' }, null, cfg), 0)
  assert.equal(logDecision({ decision: 'ask' }, null, undefined), 0) // config could not be read: no log
})

test('rotation after auditMaxBytes keeps three generations', () => {
  const cfg = withLog({ auditMaxBytes: 1000 })
  const e = makeEntry({ decision: 'ask', rule: 'geheimnis', kind: 'git commit', repo: 'r' })
  for (let i = 0; i < 100; i++) writeEntry(e, cfg)
  const names = readdirSync(auditDir(cfg)).sort()
  assert.deepEqual(names, [AUDIT_FILE, `${AUDIT_FILE}.1`, `${AUDIT_FILE}.2`, `${AUDIT_FILE}.3`])
  for (const f of names) assert.ok(statSync(join(auditDir(cfg), f)).size <= 1000, f)
  const { entries } = readEntries(cfg)
  assert.ok(entries.length > 10 && entries.length < 100)
})

test('file and folder are private to the user', { skip: process.platform === 'win32' }, () => {
  const cfg = withLog()
  writeEntry(makeEntry({ decision: 'ask' }), cfg)
  assert.equal(statSync(auditFile(cfg)).mode & 0o777, 0o600)
  assert.equal(statSync(auditDir(cfg)).mode & 0o077, 0)
})

test('broken lines are skipped and counted', () => {
  const cfg = withLog()
  writeEntry(makeEntry({ decision: 'deny', rule: 'force-push', kind: 'git push', repo: 'r' }), cfg)
  appendFileSync(auditFile(cfg), '{"zeit":\n[1,2]\n{"zeit":"nie","entscheidung":"geblockt","regel":"x","repo":"r","befehl":"b"}\n\n{"zeit":"2026-01-01T00:00:00Z","entscheidung":"vielleicht","regel":"x","repo":"r","befehl":"b"}\n')
  writeEntry(makeEntry({ decision: 'ask', rule: 'geheimnis', kind: 'git commit', repo: 'r' }), cfg)
  const { entries, broken } = readEntries(cfg)
  assert.equal(entries.length, 2)
  assert.equal(broken, 4)
})

test('--leeren moves the log aside instead of deleting it', () => {
  const cfg = withLog({ auditMaxBytes: 1000 })
  const e = makeEntry({ decision: 'ask', rule: 'geheimnis', kind: 'git commit', repo: 'r' })
  for (let i = 0; i < 20; i++) writeEntry(e, cfg)
  const before = readEntries(cfg).entries.length
  const moved = clearLog(cfg, new Date('2026-11-02T03:04:05Z'))
  assert.ok(moved.length >= 2)
  assert.ok(moved.every(m => existsSync(m) && /sicherung-2026-11-02T03-04-05-000Z$/.test(m)))
  assert.equal(readEntries(cfg).entries.length, 0)
  assert.equal(moved.reduce((s, m) => s + readFileSync(m, 'utf8').trim().split('\n').length, 0), before)
  assert.deepEqual(clearLog(cfg), [])
})

// ---- report

const NOW = new Date(2026, 10, 19, 18, 0) // local time
const at = (daysAgo, hour = 12) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, hour).toISOString()
const E = (daysAgo, entscheidung, regel, repo, befehl = 'git push') => ({ zeit: at(daysAgo), entscheidung, regel, repo, befehl })
const SAMPLE = [
  E(20, 'geblockt', 'gesperrter-branch', 'alt'),
  E(6, 'geblockt', 'gesperrter-branch', 'eins'),
  E(5, 'gewarnt', 'geheimnis', 'eins', 'git commit'),
  E(3, 'gewarnt', 'geheimnis', 'zwei', 'git commit'),
  E(3, 'gewarnt', 'geheimnis', 'zwei', 'git commit'),
  E(2, 'gewarnt', 'geheimnis', 'zwei', 'git commit'),
  E(1, 'gewarnt', 'geheimnis', 'zwei', 'git commit'),
  E(1, 'gewarnt', 'immer-fragen', 'eins'),
  E(0, 'erlaubt', 'keine', 'eins'),
]

test('report sums per decision, rule and repo within the period', () => {
  const s = summarize(SAMPLE, { tage: 7, now: NOW })
  assert.equal(s.faelle, 8)
  assert.deepEqual(s.entscheidungen, { geblockt: 1, gewarnt: 6, erlaubt: 1 })
  assert.deepEqual(s.regeln, { geheimnis: 5, 'gesperrter-branch': 1, 'immer-fragen': 1, keine: 1 })
  assert.deepEqual(s.repos, { eins: 4, zwei: 4 })
  assert.equal(s.tage.length, 7)
  assert.equal(s.tage.at(-1).tag, dayOf(NOW))
  assert.deepEqual(s.tage.find(t => t.tag === dayOf(new Date(at(3)))), { tag: dayOf(new Date(at(3))), geblockt: 0, gewarnt: 2, erlaubt: 0 })
  assert.equal(s.letzte.length, 8)
  assert.equal(s.letzte[0].entscheidung, 'erlaubt') // newest first
  assert.deepEqual(s.ausnahmeKandidaten, [{ regel: 'geheimnis', anzahl: 5 }])
})

test('report filters: repo, days, all', () => {
  assert.equal(summarize(SAMPLE, { tage: 7, repo: 'zwei', now: NOW }).faelle, 4)
  assert.equal(summarize(SAMPLE, { tage: 7, repo: 'ZWEI', now: NOW }).faelle, 4)
  assert.equal(summarize(SAMPLE, { tage: 2, now: NOW }).faelle, 3) // today and yesterday
  assert.equal(summarize(SAMPLE, { tage: 1, now: NOW }).faelle, 1)
  const all = summarize(SAMPLE, { tage: 0, now: NOW })
  assert.equal(all.faelle, 9)
  assert.equal(all.zeitraum.tage, 'alle')
  assert.equal(all.tage.length, 21)
  const full = [{ ...SAMPLE[1], repo: '/srv/code/eins' }]
  assert.equal(summarize(full, { tage: 7, repo: 'eins', now: NOW }).faelle, 1)
  assert.equal(summarize(SAMPLE, { tage: 7, repo: 'keins', now: NOW }).faelle, 0)
  // fewer than five warnings are never a candidate
  assert.deepEqual(summarize(SAMPLE.slice(0, 5), { tage: 7, now: NOW }).ausnahmeKandidaten, [])
})

test('text and markdown output', () => {
  const s = summarize(SAMPLE, { tage: 7, now: NOW, broken: 2 })
  const text = formatText(s)
  assert.match(text, /letzte 7 Tage \(alle Repos\)/)
  assert.match(text, /Fälle: 8 \(geblockt 1, gewarnt 6, erlaubt 1\)/)
  assert.match(text, /geheimnis +5/)
  assert.match(text, /\+{30}/) // the busiest day gets the full bar
  assert.match(text, /Letzte 8 Fälle/)
  assert.match(text, /geheimnis \(5× gewarnt\): Kandidat/)
  assert.match(text, /kaputte Zeilen: 2/)
  const md = formatMarkdown(s)
  assert.match(md, /^## /)
  assert.match(md, /\| geheimnis \| 5 \|/)
  assert.match(formatText(summarize([], { now: NOW })), /Keine Einträge/)
  // repo names cannot break the markdown table
  assert.match(formatMarkdown(summarize([E(0, 'gewarnt', 'x', 'a|b')], { now: NOW })), /a\\\|b/)
})

test('report arguments', () => {
  assert.deepEqual(parseArgs([]).options, { tage: 7, repo: undefined, format: 'text', leeren: false, hilfe: false })
  assert.deepEqual(parseArgs(['--tage', '30', '--repo', 'x', '--format=json']).options, { tage: 30, repo: 'x', format: 'json', leeren: false, hilfe: false })
  assert.equal(parseArgs(['--leeren']).options.leeren, true)
  for (const bad of [['--tage'], ['--tage', '-1'], ['--tage', 'x'], ['--format', 'html'], ['--repo'], ['--was'], ['--leeren=1']]) assert.ok(parseArgs(bad).error, bad.join(' '))
})

test('runReport: json from the log, --leeren, errors', () => {
  const cfg = withLog()
  for (const e of SAMPLE) writeEntry(e, cfg)
  appendFileSync(auditFile(cfg), 'kaputt\n')
  let out = ''
  let err = ''
  const io = { config: cfg, now: NOW, out: s => { out += s }, err: s => { err += s } }
  assert.equal(runReport(['--format', 'json', '--repo', 'eins'], io), 0)
  const s = JSON.parse(out)
  assert.equal(s.faelle, 4)
  assert.equal(s.kaputteZeilen, 1)
  out = ''
  assert.equal(runReport(['--leeren'], io), 0)
  assert.match(out, /sicherung-/)
  out = ''
  assert.equal(runReport([], io), 0)
  assert.match(out, /Fälle: 0/)
  assert.equal(runReport(['--format', 'pdf'], io), 2)
  assert.match(err, /text, json oder md/)
})

test('the CLI runs as `waechter report` and the hook still answers on stdin', () => {
  const cfgFile = join(root, `cfg-${++n}.json`)
  const dir = freshDir()
  writeFileSync(cfgFile, JSON.stringify({ publicRepoPatterns: ['example/public'], blockedBranches: ['old'], auditDir: dir }))
  const env = { ...process.env, WAECHTER_CONFIG: cfgFile }
  const script = new URL('../waechter.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const pub = mk(PUBLIC, 'cli-repo')
  const answer = execFileSync(process.execPath, [script], { env, input: JSON.stringify(bash('git push origin old', pub.dir)), encoding: 'utf8' })
  assert.equal(JSON.parse(answer).hookSpecificOutput.permissionDecision, 'deny')
  const report = execFileSync(process.execPath, [script, 'report', '--format', 'json'], { env, encoding: 'utf8' })
  const s = JSON.parse(report)
  assert.equal(s.faelle, 1)
  assert.deepEqual(s.repos, { 'cli-repo': 1 })
})
