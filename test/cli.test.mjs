import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, statSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { doctor, formatDoctor, parseArgs, claudeDir, configPath, scriptFromCommand, selfTest, STARTER_CONFIG } from '../cli.mjs'
import { hookCommand } from '../setup.mjs'

const SCRIPT = fileURLToPath(new URL('../waechter.mjs', import.meta.url))
const temp = () => mkdtempSync(join(tmpdir(), 'waechter-cli-'))

// Environment of every CLI run: home folder bent to a temp folder, no inherited config paths.
function envFor(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra }
  for (const k of ['XDG_CONFIG_HOME', 'WAECHTER_CONFIG', 'WAECHTER_CLAUDE_DIR', 'CLAUDE_CONFIG_DIR']) if (!(k in extra)) delete env[k]
  return env
}
function run(args, home, extra = {}, input = '') {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', env: envFor(home, extra), timeout: 60000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
// every file below a folder, relative
function files(dir) {
  const out = []
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : out.push(relative(dir, join(d, e.name))) }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}
const FOREIGN = {
  model: 'x',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
  },
}

test('init --trocken shows the diff and writes nothing', () => {
  const home = temp()
  const r = run(['init', '--trocken'], home)
  assert.equal(r.code, 0)
  assert.match(r.out, /\+ +"PreToolUse"/)
  assert.match(r.out, /Dry run: nothing was written/)
  assert.deepEqual(files(home), [])
})

test('init without --ja and without a terminal writes nothing', () => {
  const home = temp()
  const r = run(['init'], home)
  assert.equal(r.code, 1)
  assert.match(r.out, /Nothing was written\. Run again with --ja/)
  assert.deepEqual(files(home), [])
})

test('without --ziel only the (bent) home folder is used; nothing lands anywhere else', () => {
  const home = temp()
  const r = run(['init', '--ja'], home)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(files(home), ['.claude/settings.json', '.config/waechter/config.json'].map(p => join(...p.split('/'))))
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, hookCommand(SCRIPT))
  assert.equal(readFileSync(join(home, '.config', 'waechter', 'config.json'), 'utf8'), STARTER_CONFIG)
  assert.deepEqual(JSON.parse(STARTER_CONFIG), { publicRepoPatterns: [] }, 'starter config adds nothing beyond the defaults')
})

test('CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME are respected', () => {
  const home = temp()
  const cdir = join(temp(), 'claude')
  const xdg = temp()
  assert.equal(run(['init', '--ja'], home, { CLAUDE_CONFIG_DIR: cdir, XDG_CONFIG_HOME: xdg }).code, 0)
  assert.deepEqual(files(home), [])
  assert.ok(existsSync(join(cdir, 'settings.json')))
  assert.ok(existsSync(join(xdg, 'waechter', 'config.json')))
})

test('init keeps foreign hooks, makes a backup, and a second run adds no duplicate', () => {
  const home = temp()
  const ziel = join(home, 'c')
  mkdirSync(ziel)
  const original = JSON.stringify(FOREIGN, null, 4)
  writeFileSync(join(ziel, 'settings.json'), original)
  const cfg = join(home, 'cfg.json')
  writeFileSync(cfg, '{}')
  const r = run(['init', '--ziel', ziel, '--config', cfg, '--ja'], home)
  assert.equal(r.code, 0, r.err)
  const backups = readdirSync(ziel).filter(f => f.startsWith('settings.json.waechter-backup-'))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(ziel, backups[0]), 'utf8'), original)
  const s = JSON.parse(readFileSync(join(ziel, 'settings.json'), 'utf8'))
  assert.deepEqual(Object.keys(s), ['model', 'hooks'])
  assert.deepEqual(Object.keys(s.hooks), ['PreToolUse', 'Stop'])
  assert.deepEqual(s.hooks.PreToolUse.map(g => g.hooks[0].command), ['other-guard', hookCommand(SCRIPT)])
  assert.deepEqual(s.hooks.Stop, FOREIGN.hooks.Stop)

  const again = run(['init', '--ziel', ziel, '--config', cfg, '--ja'], home)
  assert.equal(again.code, 0)
  assert.match(again.out, /already installed/)
  assert.equal(readdirSync(ziel).filter(f => f.startsWith('settings.json.waechter-backup-')).length, 1)
  assert.equal(JSON.parse(readFileSync(join(ziel, 'settings.json'), 'utf8')).hooks.PreToolUse.length, 2)
})

test('init --entfernen restores the original settings', () => {
  const home = temp()
  const ziel = join(home, 'c')
  mkdirSync(ziel)
  writeFileSync(join(ziel, 'settings.json'), JSON.stringify(FOREIGN))
  const cfg = join(home, 'cfg.json')
  writeFileSync(cfg, '{}')
  assert.equal(run(['init', '--ziel', ziel, '--config', cfg, '--ja'], home).code, 0)
  const dry = run(['init', '--entfernen', '--ziel', ziel, '--trocken'], home)
  assert.match(dry.out, /- +"command": "node/)
  assert.notDeepEqual(JSON.parse(readFileSync(join(ziel, 'settings.json'), 'utf8')), FOREIGN)
  const r = run(['init', '--entfernen', '--ziel', ziel, '--ja'], home)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(readFileSync(join(ziel, 'settings.json'), 'utf8')), FOREIGN)
  assert.match(run(['init', '--entfernen', '--ziel', ziel, '--ja'], home).out, /No waechter entry found/)
})

test('broken settings JSON aborts with a clear message and changes nothing', () => {
  const home = temp()
  const ziel = join(home, 'c')
  mkdirSync(ziel)
  writeFileSync(join(ziel, 'settings.json'), '{ "hooks": ')
  const r = run(['init', '--ziel', ziel, '--ja'], home)
  assert.equal(r.code, 1)
  assert.match(r.err, /not valid JSON.*Nothing was changed/)
  assert.deepEqual(readdirSync(ziel), ['settings.json'])
  assert.equal(readFileSync(join(ziel, 'settings.json'), 'utf8'), '{ "hooks": ')
  assert.ok(!existsSync(join(home, '.config')))
})

test('without a subcommand waechter still runs as the hook', () => {
  const home = temp()
  const ls = run([], home, {}, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: home }))
  assert.equal(ls.code, 0)
  assert.equal(ls.out, '')
  const broken = run([], home, {}, 'not json')
  assert.equal(JSON.parse(broken.out).hookSpecificOutput.permissionDecision, 'ask')
})

test('help, unknown command and bad options', () => {
  const home = temp()
  assert.match(run(['help'], home).out, /waechter init/)
  assert.equal(run(['frobnicate'], home).code, 0, 'unknown first argument keeps hook behaviour (empty stdin → ask)')
  assert.equal(run(['init', '--bogus'], home).code, 2)
  assert.equal(run(['doctor', '--ja'], home).code, 2)
  assert.deepEqual(files(home), [])
  assert.deepEqual(parseArgs(['--ziel=/x', '--ja', '--config', 'c.json']), { ziel: '/x', ja: true, config: 'c.json' })
  assert.throws(() => parseArgs(['--ziel']), /needs a value/)
  assert.throws(() => parseArgs(['--ja=1']), /takes no value/)
})

test('claudeDir and configPath: option, then environment, then home folder at run time', () => {
  const env = { WAECHTER_CLAUDE_DIR: '/a', CLAUDE_CONFIG_DIR: '/b' }
  assert.equal(claudeDir({ ziel: '/z' }, env), join('/z'))
  assert.equal(claudeDir({}, env), join('/a'))
  assert.equal(claudeDir({}, { CLAUDE_CONFIG_DIR: '/b' }), join('/b'))
  assert.equal(configPath({}, { XDG_CONFIG_HOME: '/x' }), join('/x', 'waechter', 'config.json'))
  assert.equal(configPath({ config: '/c.json' }, { WAECHTER_CONFIG: '/w.json' }), join('/c.json'))
})

test('scriptFromCommand', () => {
  assert.equal(scriptFromCommand('node "/a b/waechter.mjs"'), '/a b/waechter.mjs')
  assert.equal(scriptFromCommand('node /a/waechter.mjs'), '/a/waechter.mjs')
  assert.equal(scriptFromCommand('node $UNKNOWN/waechter.mjs'), null)
  assert.equal(scriptFromCommand('npx waechter'), null)
})

// A folder with a working install: settings with the hook, a valid config.
function installed(command = hookCommand(SCRIPT), config = { publicRepoPatterns: ['example/public'] }) {
  const dir = temp()
  const ziel = join(dir, 'claude')
  mkdirSync(ziel)
  writeFileSync(join(ziel, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }))
  const cfg = join(dir, 'config.json')
  writeFileSync(cfg, typeof config === 'string' ? config : JSON.stringify(config))
  return { dir, ziel, cfg }
}
const status = (checks, name) => checks.find(c => c.name === name)?.status

test('doctor: everything fine gives exit 0 and ✓ everywhere, also as JSON', () => {
  const { dir, ziel, cfg } = installed()
  const before = files(dir)
  const r = run(['doctor', '--ziel', ziel, '--json'], temp(), { WAECHTER_CONFIG: cfg })
  assert.equal(r.code, 0, r.out)
  const json = JSON.parse(r.out)
  assert.equal(json.ok, true)
  assert.deepEqual(json.checks.map(c => c.status), json.checks.map(() => 'ok'))
  assert.deepEqual(json.checks.map(c => c.name), ['node', 'git', 'settings', 'config', 'hook', 'script', 'selftest'])
  assert.deepEqual(files(dir), before, 'doctor writes nothing')
  assert.match(run(['doctor', '--ziel', ziel], temp(), { WAECHTER_CONFIG: cfg }).out, /^waechter doctor\n✓ Node\.js[\s\S]*All good\.\n$/)
  const other = run(['doctor', '--ziel', ziel, '--config', cfg, '--json'], temp())
  assert.equal(JSON.parse(other.out).checks.find(c => c.name === 'config-path').status, 'warn', '--config that the hook does not read is pointed out')
})

test('doctor finds a missing settings file and a missing hook', () => {
  const empty = temp()
  const r = run(['doctor', '--ziel', empty], temp())
  assert.equal(r.code, 1)
  assert.match(r.out, /✗ .*settings\.json does not exist\n {4}Fix: Run "waechter init"/)
  const { ziel, cfg } = installed()
  writeFileSync(join(ziel, 'settings.json'), JSON.stringify(FOREIGN))
  assert.equal(status(doctor({ ziel, config: cfg }), 'hook'), 'fail')
})

test('doctor finds broken settings JSON', () => {
  const { ziel, cfg } = installed()
  writeFileSync(join(ziel, 'settings.json'), '{')
  assert.equal(status(doctor({ ziel, config: cfg }), 'settings'), 'fail')
})

test('doctor finds a matcher that does not cover Bash, and warns about writeCheck without Write', () => {
  const { ziel, cfg } = installed()
  writeFileSync(join(ziel, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: hookCommand(SCRIPT) }] }] } }))
  assert.equal(status(doctor({ ziel, config: cfg }), 'hook'), 'fail')
  const w = installed(undefined, { writeCheck: 'warnen' })
  assert.equal(status(doctor({ ziel: w.ziel, config: w.cfg }), 'matcher'), 'warn')
})

test('doctor finds a script path that does not exist', () => {
  const { ziel, cfg } = installed(hookCommand(join(tmpdir(), 'nowhere-' + Date.now(), 'waechter.mjs')))
  const checks = doctor({ ziel, config: cfg })
  assert.equal(status(checks, 'script'), 'fail')
  assert.equal(status(checks, 'selftest'), 'ok', 'falls back to testing this copy')
  assert.match(checks.find(c => c.name === 'selftest').message, /this copy/)
})

test('doctor finds an invalid config and reports unknown fields as a warning', () => {
  const bad = installed(undefined, { publicRepoPatterns: ['(unclosed'] })
  const c1 = doctor({ ziel: bad.ziel, config: bad.cfg })
  assert.equal(status(c1, 'config'), 'fail')
  assert.match(c1.find(c => c.name === 'config').message, /publicRepoPatterns\[0\]: invalid regex/)
  const broken = installed(undefined, '{ nope')
  assert.equal(status(doctor({ ziel: broken.ziel, config: broken.cfg }), 'config'), 'fail')
  const typo = installed(undefined, { publicRepoPattern: ['x'] })
  const c3 = doctor({ ziel: typo.ziel, config: typo.cfg })
  assert.equal(status(c3, 'config'), 'warn')
  assert.ok(!formatDoctor(c3).includes('problem'))
  const none = installed()
  assert.equal(status(doctor({ ziel: none.ziel, config: join(none.dir, 'missing.json') }), 'config'), 'warn')
})

test('doctor self-test fails for a hook script that lets everything through', () => {
  const dir = temp()
  const fakeScript = join(dir, 'waechter.mjs')
  writeFileSync(fakeScript, '// does nothing\n')
  const { ziel, cfg } = installed(hookCommand(fakeScript))
  const checks = doctor({ ziel, config: cfg })
  assert.equal(status(checks, 'script'), 'ok')
  assert.equal(status(checks, 'selftest'), 'fail')
  assert.match(checks.find(c => c.name === 'selftest').message, /instead of "deny"/)
  assert.match(selfTest(fakeScript), /instead of "deny"/)
  assert.equal(selfTest(SCRIPT), null)
})

test('doctor finds a missing git and an old Node.js', () => {
  const { ziel, cfg } = installed()
  const checks = doctor({ ziel, config: cfg }, process.env, { git: 'git-does-not-exist-' + Date.now(), nodeVersion: '16.20.0' })
  assert.equal(status(checks, 'git'), 'fail')
  assert.equal(status(checks, 'node'), 'fail')
  assert.equal(status(checks, 'selftest'), 'fail')
  assert.match(formatDoctor(checks), /3 problems found/)
})

test('the self-test leaves no temporary repo behind', () => {
  const before = readdirSync(tmpdir()).filter(f => f.startsWith('waechter-selbsttest-')).length
  selfTest(SCRIPT)
  assert.equal(readdirSync(tmpdir()).filter(f => f.startsWith('waechter-selbsttest-')).length, before)
})

test('written settings keep the mode of the old file', { skip: process.platform === 'win32' }, () => {
  const home = temp()
  const ziel = join(home, 'c')
  mkdirSync(ziel)
  writeFileSync(join(ziel, 'settings.json'), '{}', { mode: 0o640 })
  const cfg = join(home, 'cfg.json')
  writeFileSync(cfg, '{}')
  assert.equal(run(['init', '--ziel', ziel, '--config', cfg, '--ja'], home).code, 0)
  assert.equal(statSync(join(ziel, 'settings.json')).mode & 0o777, 0o640)
})

test('init writes through a symlinked settings.json and keeps the link', { skip: process.platform === 'win32' }, () => {
  const home = temp()
  mkdirSync(join(home, 'real'))
  mkdirSync(join(home, 'c'))
  writeFileSync(join(home, 'real', 'settings.json'), JSON.stringify({ model: 'x' }))
  symlinkSync(join('..', 'real', 'settings.json'), join(home, 'c', 'settings.json'))
  const cfg = join(home, 'cfg.json')
  writeFileSync(cfg, '{}')
  assert.equal(run(['init', '--ziel', join(home, 'c'), '--config', cfg, '--ja'], home).code, 0)
  assert.ok(lstatSync(join(home, 'c', 'settings.json')).isSymbolicLink())
  const s = JSON.parse(readFileSync(join(home, 'real', 'settings.json'), 'utf8'))
  assert.equal(s.model, 'x')
  assert.equal(s.hooks.PreToolUse.length, 1)
})

test('init with an existing entry that does not cover Bash fails clearly', () => {
  const { dir, ziel, cfg } = installed()
  writeFileSync(join(ziel, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: hookCommand(SCRIPT) }] }] } }))
  const r = run(['init', '--ziel', ziel, '--config', cfg, '--ja'], dir)
  assert.equal(r.code, 1)
  assert.match(r.err, /does not cover Bash/)
  const m = run(['init', '--ziel', installed().ziel, '--config', cfg, '--matcher', 'Bash|Write', '--ja'], dir)
  assert.equal(m.code, 0)
  assert.match(m.err, /--matcher "Bash\|Write" was not applied/)
})

test('init --entfernen leaves foreign hooks with similar names alone', () => {
  const home = temp()
  const ziel = join(home, 'c')
  mkdirSync(ziel)
  const foreign = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: 'node /x/my-waechter.mjs' },
    { type: 'command', command: 'node a.mjs && node /w/waechter.mjs' },
  ] }] } }
  writeFileSync(join(ziel, 'settings.json'), JSON.stringify(foreign))
  const r = run(['init', '--entfernen', '--ziel', ziel, '--ja'], home)
  assert.match(r.out, /No waechter entry found/)
  assert.deepEqual(JSON.parse(readFileSync(join(ziel, 'settings.json'), 'utf8')), foreign)
})
