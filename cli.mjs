// `waechter init` and `waechter doctor`: set up the hook in Claude Code's settings and check
// that it works. The settings folder is always a parameter (--ziel, WAECHTER_CLAUDE_DIR,
// CLAUDE_CONFIG_DIR); the home-folder default is only computed at run time.
import { execFileSync } from 'node:child_process'
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, statSync,
  accessSync, mkdtempSync, rmSync, realpathSync, constants,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  parseSettings, hookCommand, findWaechterHooks, matcherCovers, addHook, removeHook,
  formatSettings, lineDiff, compactDiff, validateConfig, DEFAULT_MATCHER,
} from './setup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OWN_SCRIPT = (() => {
  const p = join(HERE, 'waechter.mjs')
  try { return realpathSync(p) } catch { return p }
})()

export const HELP = `waechter – Claude Code hook for git commit/push

Usage:
  waechter init [--ziel <dir>] [--config <file>] [--matcher <m>] [--trocken] [--ja]
  waechter init --entfernen [--ziel <dir>] [--trocken] [--ja]
  waechter doctor [--ziel <dir>] [--config <file>] [--json]

  --ziel, --target     Claude Code settings folder (default: $WAECHTER_CLAUDE_DIR,
                       $CLAUDE_CONFIG_DIR or ~/.claude)
  --config             waechter config file (default: $WAECHTER_CONFIG or
                       $XDG_CONFIG_HOME/waechter/config.json, ~/.config/... otherwise)
  --matcher            hook matcher (default "${DEFAULT_MATCHER}")
  --trocken, --dry-run show what would change, never write
  --ja, --yes          write without asking
  --entfernen, --remove  take exactly the waechter entry out again
  --json               doctor: machine-readable output

Without arguments waechter runs as the hook (reads the tool call from stdin).`

const FLAGS = {
  '--ziel': 'ziel', '--target': 'ziel', '--config': 'config', '--matcher': 'matcher',
  '--trocken': 'trocken', '--dry-run': 'trocken', '--ja': 'ja', '--yes': 'ja', '-y': 'ja',
  '--entfernen': 'entfernen', '--remove': 'entfernen', '--json': 'json',
}
const WITH_VALUE = new Set(['ziel', 'config', 'matcher'])

export function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]
    let value
    const eq = arg.indexOf('=')
    if (arg.startsWith('--') && eq > 0) { value = arg.slice(eq + 1); arg = arg.slice(0, eq) }
    const key = FLAGS[arg]
    if (!key) throw new Error(`unknown option ${arg}`)
    if (WITH_VALUE.has(key)) {
      if (value === undefined) value = argv[++i]
      if (value === undefined || value === '') throw new Error(`${arg} needs a value`)
      opts[key] = value
    } else {
      if (value !== undefined) throw new Error(`${arg} takes no value`)
      opts[key] = true
    }
  }
  return opts
}

/** Claude Code settings folder: option, then environment, then ~/.claude (computed now, not at import). */
export function claudeDir(opts = {}, env = process.env) {
  const dir = opts.ziel || env.WAECHTER_CLAUDE_DIR || env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return resolve(dir)
}

/** waechter config path, same order as loadConfig in waechter.mjs. */
export function configPath(opts = {}, env = process.env) {
  if (opts.config) return resolve(opts.config)
  if (env.WAECHTER_CONFIG) return resolve(env.WAECHTER_CONFIG)
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'waechter', 'config.json')
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function writeAtomic(path, text) {
  const tmp = `${path}.waechter-tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  let mode
  try { mode = statSync(path).mode & 0o777 } catch {}
  writeFileSync(tmp, text, { flag: 'wx', mode: mode ?? 0o600 })
  renameSync(tmp, path)
}

async function confirm(io, question) {
  if (!io.stdin.isTTY) return false
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: io.stdin, output: io.stdout })
  try {
    return /^(j|ja|y|yes)$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

export async function init(opts, io, env = process.env) {
  const out = s => io.stdout.write(s + '\n')
  const dir = claudeDir(opts, env)
  const settingsPath = join(dir, 'settings.json')
  const exists = existsSync(settingsPath)
  const before = exists ? readFileSync(settingsPath, 'utf8') : ''
  let current
  try {
    current = parseSettings(before, settingsPath)
  } catch (e) {
    io.stderr.write(`waechter init: ${e.message}\n`)
    return 1
  }

  let result
  try {
    result = opts.entfernen ? removeHook(current) : addHook(current, hookCommand(OWN_SCRIPT), opts.matcher || DEFAULT_MATCHER)
  } catch (e) {
    io.stderr.write(`waechter init: ${e.message}\n`)
    return 1
  }
  const after = formatSettings(result.settings)
  const cfgPath = configPath(opts, env)
  const example = join(HERE, 'config.example.json')
  const createConfig = !opts.entfernen && !existsSync(cfgPath)

  out(`Settings: ${settingsPath}${exists ? '' : ' (does not exist yet)'}`)
  if (!result.changes.length) {
    if (opts.entfernen) out('No waechter entry found, nothing to remove.')
    else out(`waechter is already installed (${result.already.map(h => h.command).join(', ')}), nothing to change.`)
  } else {
    out('')
    out(compactDiff(lineDiff(before, after)))
    out('')
  }
  if (createConfig) out(`Config: ${cfgPath} does not exist yet, it will be created from config.example.json.`)
  if (!result.changes.length && !createConfig) return 0

  if (opts.trocken) { out('Dry run: nothing was written.'); return 0 }
  if (!opts.ja && !(await confirm(io, 'Write these changes? [j/N] '))) {
    out('Nothing was written. Run again with --ja to confirm.')
    return 1
  }

  if (result.changes.length) {
    mkdirSync(dir, { recursive: true })
    if (exists) {
      const backup = `${settingsPath}.waechter-backup-${stamp()}`
      copyFileSync(settingsPath, backup, constants.COPYFILE_EXCL)
      out(`Backup: ${backup}`)
    }
    writeAtomic(settingsPath, after)
    out(`Written: ${settingsPath}`)
  }
  if (createConfig) {
    mkdirSync(dirname(cfgPath), { recursive: true })
    if (existsSync(example)) copyFileSync(example, cfgPath, constants.COPYFILE_EXCL)
    else writeFileSync(cfgPath, '{}\n', { flag: 'wx' })
    out(`Config created: ${cfgPath} (set publicRepoPatterns to your public repos)`)
  }
  if (!opts.entfernen) out('Restart Claude Code (or open /hooks) so the hook is picked up, then run: waechter doctor')
  return 0
}

/** Path to the script from a hook command, with $HOME, ~ and %USERPROFILE% expanded; null if unknown. */
export function scriptFromCommand(command, env = process.env) {
  const m = command.match(/"([^"]*waechter\.mjs)"|'([^']*waechter\.mjs)'|(\S*waechter\.mjs)/)
  if (!m) return null
  const home = homedir()
  let p = (m[1] ?? m[2] ?? m[3])
    .replace(/^~(?=[/\\])/, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/%USERPROFILE%/gi, env.USERPROFILE || home)
  if (/[$%]/.test(p)) return null
  return isAbsolute(p) ? p : null
}

function gitWorks(gitCmd) {
  try {
    return execFileSync(gitCmd, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** Feeds the hook script two made-up inputs in a temporary repo. Returns null if fine, else a message. */
export function selfTest(script, gitCmd = 'git') {
  const dir = mkdtempSync(join(tmpdir(), 'waechter-selbsttest-'))
  try {
    const repo = join(dir, 'repo')
    const g = (...a) => execFileSync(gitCmd, ['-C', repo, ...a], { stdio: 'ignore', timeout: 10000 })
    mkdirSync(repo)
    g('init', '-q')
    g('remote', 'add', 'origin', 'git@github.com:waechter-selbsttest/public.git')
    g('config', 'user.name', 'selbsttest')
    g('config', 'user.email', 'selbsttest@users.noreply.github.com')
    // made up at run time: matches the AWS key pattern, belongs to nobody
    const fakeKey = 'AKIA' + Array.from(randomBytes(16), b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[b % 32]).join('')
    writeFileSync(join(repo, 'f.txt'), `key=${fakeKey}\n`)
    g('add', 'f.txt')
    const cfg = join(dir, 'config.json')
    writeFileSync(cfg, JSON.stringify({ publicRepoPatterns: ['waechter-selbsttest/public'] }))
    const run = command => {
      const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo })
      const stdout = execFileSync(process.execPath, [script], {
        input, encoding: 'utf8', timeout: 30000, cwd: repo, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, WAECHTER_CONFIG: cfg },
      })
      return stdout.trim() ? JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? 'unreadable' : 'none'
    }
    const harmless = run('git status')
    if (harmless !== 'none') return `a harmless "git status" got "${harmless}" instead of passing`
    const blocked = run('git commit -m selftest')
    if (blocked !== 'deny') return `a commit with a made-up key in a public repo got "${blocked}" instead of "deny"`
    return null
  } catch (e) {
    return `the hook could not be run (${String(e.message).split('\n')[0]})`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Runs all doctor checks. Never writes outside a temporary folder.
 * Returns [{ name, status: 'ok' | 'warn' | 'fail', message, fix? }].
 */
export function doctor(opts = {}, env = process.env, deps = {}) {
  const checks = []
  const add = (name, status, message, fix) => checks.push(fix ? { name, status, message, fix } : { name, status, message })
  const nodeVersion = deps.nodeVersion ?? process.versions.node
  const gitCmd = deps.git ?? 'git'

  const major = Number(String(nodeVersion).split('.')[0])
  if (major >= 18) add('node', 'ok', `Node.js ${nodeVersion} (18 or newer needed)`)
  else add('node', 'fail', `Node.js ${nodeVersion} is too old (18 or newer needed)`, 'Install Node.js 18 or newer (https://nodejs.org).')

  const gitVersion = gitWorks(gitCmd)
  if (gitVersion) add('git', 'ok', gitVersion)
  else add('git', 'fail', 'git was not found', 'Install git and make sure it is on PATH.')

  const settingsPath = join(claudeDir(opts, env), 'settings.json')
  let settings = null
  if (!existsSync(settingsPath)) {
    add('settings', 'fail', `${settingsPath} does not exist`, 'Run "waechter init" (or pass --ziel <folder> if Claude Code uses another folder).')
  } else {
    try {
      settings = parseSettings(readFileSync(settingsPath, 'utf8'), settingsPath)
      add('settings', 'ok', `${settingsPath} is readable`)
    } catch (e) {
      add('settings', 'fail', e.message.replace(/ Nothing was changed.*$/, ''), 'Fix the JSON by hand (or restore a waechter-backup file next to it).')
    }
  }

  // config (needed for the matcher warning below)
  const cfgPath = configPath(opts, env)
  let config = {}
  if (!existsSync(cfgPath)) {
    add('config', 'warn', `no config at ${cfgPath}: only the built-in secret patterns run and no repo counts as public`, 'Run "waechter init" to create one, then set publicRepoPatterns.')
  } else {
    try {
      config = parseSettings(readFileSync(cfgPath, 'utf8'), cfgPath)
      const { errors, warnings } = validateConfig(config)
      if (errors.length) add('config', 'fail', `${cfgPath}: ${errors.join('; ')}`, 'Fix these fields; compare with config.example.json.')
      else if (warnings.length) add('config', 'warn', `${cfgPath}: ${warnings.join('; ')}`, 'Remove or rename these fields; compare with config.example.json.')
      else add('config', 'ok', `${cfgPath} is valid`)
    } catch (e) {
      add('config', 'fail', e.message.replace(/ Nothing was changed.*$/, ''), 'Fix the JSON in the config file; compare with config.example.json.')
      config = {}
    }
  }

  let script = null
  if (settings) {
    const hooks = findWaechterHooks(settings)
    const forBash = hooks.filter(h => matcherCovers(h.matcher, 'Bash'))
    if (!hooks.length) add('hook', 'fail', 'no waechter entry in hooks.PreToolUse', 'Run "waechter init".')
    else if (!forBash.length) add('hook', 'fail', `waechter is installed with matcher "${hooks[0].matcher}", which does not cover Bash`, 'Set the matcher to "Bash" (or run "waechter init --entfernen" and then "waechter init").')
    else {
      add('hook', 'ok', `hook installed: ${forBash[0].command}`)
      const ws = config.writeCheck
      if ((ws === 'warnen' || ws === 'blocken') && !hooks.some(h => matcherCovers(h.matcher, 'Write'))) {
        add('matcher', 'warn', `writeCheck is "${ws}", but the hook matcher does not cover Write/Edit`, 'Use the matcher "Bash|Write|Edit|MultiEdit|NotebookEdit".')
      }
      const cmd = forBash[0].command
      script = scriptFromCommand(cmd, env)
      if (!script) {
        add('script', 'warn', `cannot tell which file "${cmd}" runs`, 'Use the form node "/full/path/to/waechter.mjs" so it can be checked.')
      } else if (!existsSync(script)) {
        add('script', 'fail', `${script} does not exist`, 'Correct the path in settings.json, or run "waechter init --entfernen" and "waechter init" again.')
        script = null
      } else {
        const viaNode = /^\s*(?:"[^"]*node(?:\.exe)?"|\S*node(?:\.exe)?)\s/i.test(cmd)
        try {
          accessSync(script, viaNode || process.platform === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK)
          add('script', 'ok', `${script} exists${viaNode ? ' and is readable' : ' and is executable'}`)
        } catch {
          add('script', 'fail', `${script} is not ${viaNode ? 'readable' : 'executable'}`, viaNode ? 'Fix the file permissions (chmod u+r).' : 'Start it with node "<path>" or run chmod u+x on it.')
          script = null
        }
      }
    }
  }

  if (!gitVersion) {
    add('selftest', 'fail', 'skipped: git is missing', 'Install git, then run doctor again.')
  } else {
    const target = script ?? OWN_SCRIPT
    const problem = selfTest(target, gitCmd)
    const which = script ? 'installed hook' : 'this copy of waechter'
    if (problem) add('selftest', 'fail', `self-test of the ${which} failed: ${problem}`, 'Update waechter, check the path in settings.json, and run the hook by hand to see the error.')
    else add('selftest', 'ok', `self-test of the ${which}: harmless command passes, commit with a made-up key in a public repo is denied`)
  }
  return checks
}

const SYMBOL = { ok: '✓', warn: '⚠', fail: '✗' }

export function formatDoctor(checks) {
  const lines = ['waechter doctor']
  for (const c of checks) {
    lines.push(`${SYMBOL[c.status]} ${c.message}`)
    if (c.fix) lines.push(`    Fix: ${c.fix}`)
  }
  const fails = checks.filter(c => c.status === 'fail').length
  lines.push(fails ? `${fails} problem${fails === 1 ? '' : 's'} found.` : 'All good.')
  return lines.join('\n')
}

/** Entry point for `waechter <subcommand>`. Returns the exit code. */
export async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, env = process.env) {
  const [sub, ...rest] = argv
  if (sub === 'help' || sub === '--help' || sub === '-h') { io.stdout.write(HELP + '\n'); return 0 }
  let opts
  try {
    opts = parseArgs(rest)
  } catch (e) {
    io.stderr.write(`waechter ${sub}: ${e.message}\n\n${HELP}\n`)
    return 2
  }
  if (sub === 'init') {
    if (opts.json) { io.stderr.write('waechter init: --json is only for doctor\n'); return 2 }
    return init(opts, io, env)
  }
  if (sub === 'doctor') {
    if (opts.trocken || opts.ja || opts.entfernen || opts.matcher) { io.stderr.write('waechter doctor: only --ziel, --config and --json are allowed\n'); return 2 }
    const checks = doctor(opts, env)
    const ok = !checks.some(c => c.status === 'fail')
    io.stdout.write((opts.json ? JSON.stringify({ ok, checks }, null, 2) : formatDoctor(checks)) + '\n')
    return ok ? 0 : 1
  }
  io.stderr.write(`waechter: unknown command ${sub}\n\n${HELP}\n`)
  return 2
}
