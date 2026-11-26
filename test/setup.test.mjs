import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSettings, hookCommand, isWaechterHook, findWaechterHooks, matcherCovers,
  addHook, removeHook, formatSettings, lineDiff, validateConfig, DEFAULT_MATCHER,
} from '../setup.mjs'

const CMD = hookCommand('/opt/tools/waechter/waechter.mjs')

test('parseSettings: empty text is an empty object, broken JSON throws a clear error', () => {
  assert.deepEqual(parseSettings(''), {})
  assert.deepEqual(parseSettings('  \n'), {})
  assert.throws(() => parseSettings('{"hooks": '), /not valid JSON.*Nothing was changed/)
  assert.throws(() => parseSettings('[1, 2]'), /JSON object/)
  assert.throws(() => parseSettings('null'), /JSON object/)
})

test('hookCommand quotes the path and rejects quotes in it', () => {
  assert.equal(hookCommand('/a b/waechter.mjs'), 'node "/a b/waechter.mjs"')
  for (const bad of ['/a"b/waechter.mjs', '/home/u/$(touch x)/waechter.mjs', '/a/`id`/waechter.mjs', '/a\\b/waechter.mjs', '/a\nb/waechter.mjs']) {
    assert.throws(() => hookCommand(bad, 'linux'), /shell would expand/, bad)
  }
  assert.equal(hookCommand('C:\\tools\\waechter\\waechter.mjs', 'win32'), 'node "C:\\tools\\waechter\\waechter.mjs"')
  assert.throws(() => hookCommand('C:\\%TEMP%\\waechter.mjs', 'win32'), /shell would expand/)
})

test('isWaechterHook recognises the usual forms and nothing else', () => {
  for (const command of [CMD, 'node $HOME/path/to/waechter/waechter.mjs', 'node "C:\\tools\\waechter\\waechter.mjs"', 'npx waechter', '/usr/local/bin/waechter']) {
    assert.ok(isWaechterHook({ type: 'command', command }), command)
  }
  for (const command of ['node other.mjs', 'echo waechter-ish', 'node /x/waechter-old/run.mjs', 'waechter report', 'node /x/not-waechter.mjs',
    'node /x/run-waechter.mjs --wrap', 'echo waechter', 'node a.mjs && node /w/waechter.mjs', 'node /x/waechter.mjs; rm -rf x']) {
    assert.ok(!isWaechterHook({ type: 'command', command }), command)
  }
  assert.ok(!isWaechterHook(null))
  assert.ok(!isWaechterHook({ type: 'command' }))
})

test('addHook into empty settings', () => {
  const { settings, changes } = addHook({}, CMD)
  assert.deepEqual(settings, { hooks: { PreToolUse: [{ matcher: DEFAULT_MATCHER, hooks: [{ type: 'command', command: CMD }] }] } })
  assert.equal(changes.length, 3)
})

test('addHook keeps foreign hooks, their order and unknown fields; input stays untouched', () => {
  const input = {
    model: 'x',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard', timeout: 5 }], extra: true }],
    },
    zzz: [1, 2],
  }
  const before = JSON.stringify(input)
  const { settings, changes } = addHook(input, CMD)
  assert.equal(JSON.stringify(input), before)
  assert.deepEqual(Object.keys(settings), ['model', 'permissions', 'hooks', 'zzz'])
  assert.deepEqual(Object.keys(settings.hooks), ['PostToolUse', 'PreToolUse'])
  assert.deepEqual(settings.hooks.PreToolUse[0], input.hooks.PreToolUse[0])
  assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, CMD)
  assert.equal(changes.length, 1)
})

test('addHook does not add a second entry when waechter is already installed', () => {
  const once = addHook({}, CMD).settings
  const { settings, changes, already } = addHook(once, hookCommand('/elsewhere/waechter.mjs'))
  assert.deepEqual(settings, once)
  assert.deepEqual(changes, [])
  assert.equal(already.length, 1)
  assert.equal(findWaechterHooks(settings).length, 1)
})

test('addHook refuses settings with a wrong shape instead of overwriting', () => {
  assert.throws(() => addHook({ hooks: [] }, CMD), /not an object/)
  assert.throws(() => addHook({ hooks: { PreToolUse: {} } }, CMD), /not a list/)
})

test('removeHook gives back the original object', () => {
  const inputs = [
    {},
    { model: 'x' },
    { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier' }] }] } },
    { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard' }] }] }, z: 1 },
  ]
  for (const input of inputs) {
    const added = addHook(input, CMD).settings
    const { settings, changes } = removeHook(added)
    assert.deepEqual(settings, input)
    assert.equal(changes.length, 1)
  }
})

test('removeHook takes waechter out of a shared group and leaves the rest', () => {
  const input = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: CMD }, { type: 'command', command: 'b' }] }] } }
  const { settings } = removeHook(input)
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks.map(h => h.command), ['a', 'b'])
})

test('removeHook without a waechter entry changes nothing', () => {
  const input = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] } }
  const { settings, changes } = removeHook(input)
  assert.deepEqual(settings, input)
  assert.deepEqual(changes, [])
})

test('matcherCovers', () => {
  assert.ok(matcherCovers('Bash', 'Bash'))
  assert.ok(matcherCovers('', 'Bash'))
  assert.ok(matcherCovers('*', 'Bash'))
  assert.ok(matcherCovers('Bash|Write', 'Write'))
  assert.ok(!matcherCovers('Write', 'Bash'))
  assert.ok(!matcherCovers('BashX', 'Bash'))
  assert.ok(!matcherCovers('(', 'Bash'))
})

test('lineDiff marks changed and added lines', () => {
  const before = formatSettings({ a: 1 })
  const after = formatSettings({ a: 1, b: 2 })
  const diff = lineDiff(before, after).split('\n')
  assert.deepEqual(diff.filter(l => l.startsWith('+ ')), ['+   "a": 1,', '+   "b": 2'])
  assert.deepEqual(diff.filter(l => l.startsWith('- ')), ['-   "a": 1'])
  assert.equal(lineDiff('', 'x\n'), '+ x')
  assert.equal(lineDiff('x\n', 'x\n'), '  x')
})

test('validateConfig: valid example passes, every field is checked', () => {
  assert.deepEqual(validateConfig({ publicRepoPatterns: ['a/b'], blockForcePush: true, writeCheck: 'warnen', maxDiffMegabytes: 5, skipScanPaths: ['**/*.lock'] }), { errors: [], warnings: [] })
  const bad = validateConfig({
    publicRepoPatterns: 'a/b',
    privateEmailPatterns: ['(unclosed'],
    blockedBranches: [3],
    blockForcePush: 'yes',
    requiredEmailPattern: '[',
    maxDiffMegabytes: -1,
    writeCheckMaxBytes: '10',
    writeCheck: 'on',
    publicRepoPattern: ['typo'],
  })
  assert.equal(bad.errors.length, 8, bad.errors.join('\n'))
  assert.deepEqual(bad.warnings, ['publicRepoPattern: unknown field (typo? it is ignored)'])
  assert.deepEqual(validateConfig([]).errors.length, 1)
})
