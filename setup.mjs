// Pure helpers for `waechter init` and `waechter doctor`: merging the hook entry into a
// Claude Code settings object, removing it again, a small line diff and config validation.
// No file system access here, so everything is testable with plain objects.
import { DEFAULT_CONFIG } from './waechter.mjs'

export const DEFAULT_MATCHER = 'Bash'
export const WRITE_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit'

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const clone = v => JSON.parse(JSON.stringify(v))

/** Parses settings text. Empty text is an empty object; broken JSON throws a clear error. */
export function parseSettings(text, label = 'settings.json') {
  if (!text.trim()) return {}
  let value
  try {
    value = JSON.parse(text)
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${e.message}). Nothing was changed; fix the file or move it away first.`)
  }
  if (!isObject(value)) throw new Error(`${label} must contain a JSON object at the top level. Nothing was changed.`)
  return value
}

/** The hook command for a script path. Quoted so paths with spaces work. */
export function hookCommand(scriptPath) {
  if (/["\n\r]/.test(scriptPath)) throw new Error('the path to waechter.mjs contains a quote or line break; move it to a simpler path')
  return `node "${scriptPath}"`
}

/** True for a hook entry that runs waechter (`.../waechter.mjs`, also via `npx waechter`). */
export function isWaechterHook(hook) {
  if (!isObject(hook) || typeof hook.command !== 'string') return false
  return /waechter\.mjs\b|(?:^|[\s/\\"'])waechter["']?\s*$/.test(hook.command)
}

/** All waechter hook entries in PreToolUse: [{ matcher, command }]. */
export function findWaechterHooks(settings) {
  const groups = isObject(settings?.hooks) && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : []
  const found = []
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue
    for (const hook of group.hooks) {
      if (isWaechterHook(hook)) found.push({ matcher: typeof group.matcher === 'string' ? group.matcher : '', command: hook.command })
    }
  }
  return found
}

/** True if a hook matcher (a regex in Claude Code; empty or "*" means all tools) covers a tool name. */
export function matcherCovers(matcher, tool) {
  if (!matcher || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool)
  } catch {
    return false
  }
}

/**
 * Adds the waechter hook to a settings object.
 * Returns { settings, changes } with a new object; the input is never modified.
 * Existing hooks, their order and unknown fields stay as they are. If a waechter entry
 * already exists, nothing changes (no duplicate).
 */
export function addHook(input, command, matcher = DEFAULT_MATCHER) {
  const settings = clone(input ?? {})
  if (!isObject(settings)) throw new Error('settings must be a JSON object')
  if (settings.hooks !== undefined && !isObject(settings.hooks)) throw new Error('"hooks" in settings.json is not an object; fix it by hand first')
  const pre = settings.hooks?.PreToolUse
  if (pre !== undefined && !Array.isArray(pre)) throw new Error('"hooks.PreToolUse" in settings.json is not a list; fix it by hand first')
  const existing = findWaechterHooks(settings)
  if (existing.length) return { settings, changes: [], already: existing }
  const changes = []
  if (!settings.hooks) { settings.hooks = {}; changes.push('create "hooks"') }
  if (!settings.hooks.PreToolUse) { settings.hooks.PreToolUse = []; changes.push('create "hooks.PreToolUse"') }
  settings.hooks.PreToolUse.push({ matcher, hooks: [{ type: 'command', command }] })
  changes.push(`add PreToolUse hook (matcher "${matcher}"): ${command}`)
  return { settings, changes, already: [] }
}

/**
 * Removes exactly the waechter hook entries. Groups, PreToolUse and hooks that become empty
 * through this are removed too, so init followed by remove gives back the original object.
 */
export function removeHook(input) {
  const settings = clone(input ?? {})
  const changes = []
  const groups = isObject(settings.hooks) && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : null
  if (!groups) return { settings, changes }
  const kept = []
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) { kept.push(group); continue }
    const rest = group.hooks.filter(h => !isWaechterHook(h))
    for (const h of group.hooks) if (isWaechterHook(h)) changes.push(`remove PreToolUse hook: ${h.command}`)
    if (rest.length === group.hooks.length) kept.push(group)
    else if (rest.length) kept.push({ ...group, hooks: rest })
  }
  if (!changes.length) return { settings, changes }
  if (kept.length) settings.hooks.PreToolUse = kept
  else delete settings.hooks.PreToolUse
  if (!Object.keys(settings.hooks).length) delete settings.hooks
  return { settings, changes }
}

/** Settings as file text: two spaces, trailing newline (like Claude Code writes it). */
export const formatSettings = settings => JSON.stringify(settings, null, 2) + '\n'

/**
 * Line diff (longest common subsequence) in unified style without hunk headers:
 * lines prefixed with "  ", "- " or "+ ". Meant for small files like settings.json.
 */
export function lineDiff(before, after) {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n')
  if (a.length * b.length > 4_000_000) return [...a.map(l => `- ${l}`), ...b.map(l => `+ ${l}`)].join('\n')
  const n = a.length, m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const out = []
  let i = 0, j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++ }
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { out.push(`+ ${b[j]}`); j++ }
    else { out.push(`- ${a[i]}`); i++ }
  }
  return out.join('\n')
}

// Expected type per config key. Unknown keys are reported as warnings, not errors,
// so a config written for a newer waechter still passes.
const REGEX_LISTS = ['publicRepoPatterns', 'alwaysAskRepoPatterns', 'privateEmailPatterns', 'privatePathPatterns', 'phonePatterns', 'writeCheckIgnorePaths']
const STRING_LISTS = ['blockedBranches', 'skipScanPaths']
const WRITE_CHECK = ['aus', 'warnen', 'blocken']

/**
 * Checks a parsed config object field by field.
 * Returns { errors: [text], warnings: [text] }; empty lists mean the config is valid.
 */
export function validateConfig(config) {
  const errors = []
  const warnings = []
  if (!isObject(config)) return { errors: ['the config must be a JSON object'], warnings }
  for (const [key, value] of Object.entries(config)) {
    if (REGEX_LISTS.includes(key) || STRING_LISTS.includes(key)) {
      if (!Array.isArray(value)) { errors.push(`${key}: must be a list of strings`); continue }
      value.forEach((s, i) => {
        if (typeof s !== 'string') { errors.push(`${key}[${i}]: must be a string`); return }
        if (!REGEX_LISTS.includes(key)) return
        try { new RegExp(s, 'i') } catch (e) { errors.push(`${key}[${i}]: invalid regex (${e.message})`) }
      })
    } else if (key === 'blockForcePush') {
      if (typeof value !== 'boolean') errors.push('blockForcePush: must be true or false')
    } else if (key === 'requiredEmailPattern') {
      if (typeof value !== 'string') errors.push('requiredEmailPattern: must be a string (regex)')
      else try { new RegExp(value, 'i') } catch (e) { errors.push(`requiredEmailPattern: invalid regex (${e.message})`) }
    } else if (key === 'maxDiffMegabytes' || key === 'writeCheckMaxBytes') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) errors.push(`${key}: must be a positive number`)
    } else if (key === 'writeCheck') {
      if (!WRITE_CHECK.includes(value)) errors.push(`writeCheck: must be one of ${WRITE_CHECK.map(v => `"${v}"`).join(', ')}`)
    } else if (!(key in DEFAULT_CONFIG)) {
      warnings.push(`${key}: unknown field (typo? it is ignored)`)
    }
  }
  return { errors, warnings }
}
