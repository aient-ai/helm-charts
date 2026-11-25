// One render per distinct kustomize input, shared by every quality test file a CI shard runs (QUALITY_RENDER_CACHE_DIR).
// About three in four renders in tests/quality repeat an identical render of the same tree from another test file, and
// each test file is its own process, so the cache is on disk.
//
// The key is the bytes of every input the render can read, found by walking the kustomizations from the target, so an
// edit to any of them, committed or not, renders again. A render is cached only when that walk accounts for all of
// them:
// - every kustomization uses only keys the walk knows, and every path it names (resources, components, bases, patches,
//   generator files, CRDs, configurations, OpenAPI, replacements) resolves inside the repository or the render
//   helper's own staging root: an absolute or escaping path, a remote base or ?ref=, or a helm chart means no cache;
// - no plugin runs, except renderWithSyntheticKsops' stand-in, first on PATH in its own directory behind ksops-only
//   generators, whose bytes join the key;
// - the key also holds the kustomize binary's hash, every KUSTOMIZE_* variable (KUSTOMIZE_PLUGIN_HOME among them),
//   XDG_CONFIG_HOME and the other arguments.
// Anything else renders as before.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, parseAllDocuments } from 'yaml'
import { removeTempDirectorySync } from './temp-directory-cleanup.mjs'
import { run, succeeded } from '../run-bounded.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const KUSTOMIZATION_NAMES = ['kustomization.yaml', 'kustomization.yml', 'Kustomization']
// Helper staging roots: a directory whose name starts with one of these and whose parent is the system temp directory.
const STAGING_PREFIXES = ['public-overlay-', 'synthetic-ksops-']
const REMOTE_OR_HELM = /https?:\/\/|(^|[\s'"[,-])github\.com\/|\?ref=|helmCharts|helmChartInflationGenerator|helmGlobals/
const PLUGINS = /config\.kubernetes\.io\/function|^\s*exec:/m
const PLUGIN_FLAGS = new Set(['--enable-alpha-plugins', '--enable-exec'])
const UNCACHEABLE_FLAGS = /^--(enable-helm|enable-star|helm-command|mount)/
// renderWithSyntheticKsops' stand-in: the only exec function a cached render may run, and only from its own directory.
const SYNTHETIC_KSOPS_DIRECTORY = /^aient-synthetic-ksops-/
// The kustomization keys the walk understands. Any other key may name a file it would miss, so it means no cache.
const KNOWN_KEYS = new Set(['apiVersion', 'kind', 'metadata', 'namespace', 'namePrefix', 'nameSuffix', 'commonLabels',
  'labels', 'commonAnnotations', 'images', 'replicas', 'resources', 'components', 'bases', 'patches',
  'patchesStrategicMerge', 'patchesJson6902', 'configMapGenerator', 'secretGenerator', 'generatorOptions', 'crds',
  'configurations', 'openapi', 'replacements', 'sortOptions', 'buildMetadata', 'vars', 'generators'])

const sha = (value) => createHash('sha256').update(value).digest('hex')

function binaryPath(file, env) {
  if (file.includes('/')) return path.resolve(file)
  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, file)
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch { /* next */ }
  }
  return null
}

/** The binary's content hash, computed once per run for each (path, size, mtime). */
function binaryHash(cacheDir, binary) {
  const stat = fs.statSync(binary)
  const marker = path.join(cacheDir, `binary-${sha(`${binary}\0${stat.size}\0${stat.mtimeMs}`)}`)
  try { return fs.readFileSync(marker, 'utf8') } catch { /* first use */ }
  const hash = sha(fs.readFileSync(binary))
  writeAtomically(marker, hash)
  return hash
}

function writeAtomically(target, content) {
  const temporary = `${target}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, content)
  fs.renameSync(temporary, target)
}

function kustomizationIn(directory) {
  for (const name of KUSTOMIZATION_NAMES) {
    const file = path.join(directory, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

/** A generator file whose only exec function is ksops, so the synthetic stand-in is all it runs. */
function ksopsOnlyGenerator(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false
  const text = fs.readFileSync(file, 'utf8')
  if (REMOTE_OR_HELM.test(text) || /container:|starlark/.test(text)) return false
  const paths = [...text.matchAll(/^\s*path:\s*(\S+)/gm)].map(match => match[1].replace(/['"]/g, ''))
  return paths.length > 0 && paths.every(value => value === 'ksops')
}

/** The `files:` a generator document lists (ksops' secret files), or null for a shape the walk can't read. */
function generatorFiles(file) {
  let documents
  try { documents = parseAllDocuments(fs.readFileSync(file, 'utf8')).map(document => document.toJS()) } catch { return null }
  const named = []
  for (const document of documents) {
    if (!document) continue
    const list = listOf(document.files)
    if (!list || list.some(entry => typeof entry !== 'string')) return null
    named.push(...list)
  }
  return named
}

/** The paths a kustomization names, by kind: directories it builds and files it reads. Null for a shape it can't read. */
function namedPaths(document) {
  const entries = []
  for (const key of ['resources', 'components', 'bases']) {
    const list = listOf(document[key])
    if (!list || list.some(entry => typeof entry !== 'string')) return null
    entries.push(...list.map(entry => ({ entry, either: true })))
  }
  for (const key of ['patchesStrategicMerge', 'crds', 'configurations']) {
    const list = listOf(document[key])
    if (!list || list.some(entry => typeof entry !== 'string')) return null
    entries.push(...list.map(entry => ({ entry })))
  }
  for (const key of ['patches', 'patchesJson6902', 'replacements']) {
    const list = listOf(document[key])
    if (!list) return null
    for (const item of list) if (typeof item?.path === 'string') entries.push({ entry: item.path })
  }
  if (typeof document.openapi?.path === 'string') entries.push({ entry: document.openapi.path })
  for (const key of ['configMapGenerator', 'secretGenerator']) {
    const list = listOf(document[key])
    if (!list) return null
    for (const generator of list) {
      for (const file of [...(generator?.files ?? []), ...(generator?.envs ?? []), ...(generator?.env ? [generator.env] : [])]) {
        if (typeof file !== 'string') return null
        entries.push({ entry: file.slice(file.indexOf('=') + 1) })
      }
    }
  }
  return entries
}

/**
 * Every file the render can read, from the target's kustomization down, each inside one of `roots`. Null when the walk
 * can't account for them all: an unknown key, a path outside the roots, a remote or helm input, or (unless
 * `syntheticKsops`) any plugin.
 */
function reachableInputs(target, roots, { syntheticKsops = false } = {}) {
  const inside = candidate => roots.some(root => candidate === root || candidate.startsWith(`${root}${path.sep}`))
  const pending = [target]
  const directories = new Set()
  const files = new Set()
  while (pending.length) {
    const directory = pending.pop()
    if (directories.has(directory)) continue
    directories.add(directory)
    const file = kustomizationIn(directory)
    if (!file) return null
    files.add(file)
    const text = fs.readFileSync(file, 'utf8')
    if (REMOTE_OR_HELM.test(text)) return null
    let document
    try { document = parse(text) ?? {} } catch { return null }
    if (typeof document !== 'object' || Object.keys(document).some(key => !KNOWN_KEYS.has(key))) return null
    if (document.generators || PLUGINS.test(text)) {
      if (!syntheticKsops || PLUGINS.test(text)) return null
      const generators = listOf(document.generators)
      if (!generators) return null
      for (const generator of generators) {
        const named = path.resolve(directory, String(generator))
        if (path.isAbsolute(String(generator)) || !inside(named) || !fs.existsSync(named)) return null
        const resolved = fs.realpathSync(named)
        if (!inside(resolved) || !ksopsOnlyGenerator(resolved)) return null
        files.add(resolved)
        // The files the generator hands the stand-in are inputs too, whatever the stand-in does with them today.
        const handed = generatorFiles(resolved)
        if (!handed) return null
        for (const entry of handed) {
          const input = path.resolve(path.dirname(resolved), entry)
          if (path.isAbsolute(entry) || !inside(input)) return null
          const real = fs.existsSync(input) ? fs.realpathSync(input) : input
          if (!inside(real)) return null
          files.add(real)
        }
      }
    }
    const entries = namedPaths(document)
    if (!entries) return null
    for (const { entry, either } of entries) {
      if (path.isAbsolute(entry) || entry.includes('://')) return null
      // Containment holds on the real path, so a symlink can't lead the render outside the roots either.
      const named = path.resolve(directory, entry)
      if (!inside(named)) return null
      if (!fs.existsSync(named)) { files.add(named); continue }
      const resolved = fs.realpathSync(named)
      if (!inside(resolved)) return null
      const stat = fs.statSync(resolved)
      if (stat.isDirectory()) { if (!either) return null; pending.push(resolved) } else files.add(resolved)
    }
  }
  return [...files].sort()
}

/** The list a kustomization key holds: [] when absent, null for any other shape. */
function listOf(value) { return Array.isArray(value) ? value : value === undefined ? [] : null }

function stagingRoot(directory) {
  const temp = fs.realpathSync(os.tmpdir())
  let current = fs.realpathSync(directory)
  while (path.dirname(current) !== current) {
    if (path.dirname(current) === temp && STAGING_PREFIXES.some(prefix => path.basename(current).startsWith(prefix))) return current
    current = path.dirname(current)
  }
  return null
}

/** One input's identity in the key: which root it is under, its path there, and its bytes (or that it is missing). */
function inputIdentity(file, roots) {
  const index = roots.findIndex(candidate => file.startsWith(`${candidate}${path.sep}`))
  const root = roots[index]
  const label = index === 0 ? 'repository' : 'staging'
  const bytes = fs.existsSync(file) ? sha(fs.readFileSync(file)) : 'missing'
  return `${label}:${path.relative(root, file)}:${bytes}`
}

/**
 * The cache entry for a `kustomize build` call, or null when this call is not cached. `args` are the kustomize
 * arguments; `cwd` and `env` are the spawn's (its own environment decides: a test that clears the variable renders
 * uncached).
 */
export function kustomizeCacheEntry(file, args, { cwd: given = process.cwd(), env = process.env, caller = '' } = {}) {
  const cacheDir = env.QUALITY_RENDER_CACHE_DIR
  // A spawn's cwd may be a file: URL, as node:child_process accepts.
  const cwd = given instanceof URL ? fileURLToPath(given) : String(given)
  if (!cacheDir || path.basename(file) !== 'kustomize' || args[0] !== 'build') return null
  try {
    let target
    let output = null
    let plugins = false
    const rest = []
    for (let index = 1; index < args.length; index += 1) {
      const arg = String(args[index])
      if (arg === '--output' || arg === '-o') { output = path.resolve(cwd, String(args[index += 1])); continue }
      if (arg.startsWith('--output=')) { output = path.resolve(cwd, arg.slice('--output='.length)); continue }
      if (UNCACHEABLE_FLAGS.test(arg)) return null
      if (PLUGIN_FLAGS.has(arg)) { plugins = true; rest.push(arg); continue }
      if (!arg.startsWith('-') && target === undefined) { target = path.resolve(cwd, arg); continue }
      rest.push(arg)
    }
    if (!target || !fs.existsSync(target)) return null
    target = fs.realpathSync(target)
    const repository = fs.realpathSync(ROOT)
    const inRepository = target === repository || target.startsWith(`${repository}${path.sep}`)
    const staging = inRepository ? null : stagingRoot(target)
    if (!inRepository && !staging) return null
    const roots = [repository, ...(staging ? [staging] : [])]
    // With plugins on, the only exec function is the synthetic ksops stand-in first on PATH; its bytes join the key.
    let syntheticKsops = ''
    if (plugins) {
      const first = String(env.PATH ?? '').split(path.delimiter)[0] ?? ''
      if (path.dirname(fs.realpathSync(first)) !== fs.realpathSync(os.tmpdir()) || !SYNTHETIC_KSOPS_DIRECTORY.test(path.basename(first))) return null
      if (fs.readdirSync(first).join() !== 'ksops') return null
      syntheticKsops = sha(fs.readFileSync(path.join(first, 'ksops')))
    }
    const inputs = reachableInputs(target, roots, { syntheticKsops: plugins })
    if (!inputs) return null
    const binary = binaryPath(file, env)
    if (!binary) return null
    fs.mkdirSync(cacheDir, { recursive: true })
    const key = sha(JSON.stringify({
      binary: binaryHash(cacheDir, binary), xdg: env.XDG_CONFIG_HOME ?? '',
      kustomizeEnv: Object.entries(env).filter(([name]) => name.startsWith('KUSTOMIZE_')).sort(),
      target: inputIdentity(path.join(target, path.basename(kustomizationIn(target))), roots),
      inputs: inputs.map(input => inputIdentity(input, roots)), rest, syntheticKsops, output: output !== null,
      // The entry point and its output limit: the sync path keeps no stderr, and a smaller maxBuffer must fail as before.
      caller,
    }))
    return { directory: path.join(cacheDir, key), output }
  } catch {
    return null
  }
}

/** A cached render: `{ stdout, stderr }`, with any --output files written to the call's output directory. */
export function readCachedRender(entry) {
  try {
    const stdout = fs.readFileSync(path.join(entry.directory, 'stdout'), 'utf8')
    const stderr = fs.readFileSync(path.join(entry.directory, 'stderr'), 'utf8')
    if (entry.output) fs.cpSync(path.join(entry.directory, 'output'), entry.output, { recursive: true })
    return { stdout, stderr }
  } catch {
    return null
  }
}

/** Saves a successful render. A concurrent writer of the same key wins harmlessly: both rendered the same bytes. */
export function writeCachedRender(entry, { stdout, stderr }) {
  const staging = `${entry.directory}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'stdout'), stdout)
    fs.writeFileSync(path.join(staging, 'stderr'), stderr)
    if (entry.output) fs.cpSync(entry.output, path.join(staging, 'output'), { recursive: true })
    fs.renameSync(staging, entry.directory)
  } catch {
    removeTempDirectorySync(staging)
  }
}

/** Appends one line (hit, miss) to the shard's cache event log, which the quality job summarises. */
export function recordCacheEvent(event) {
  const cacheDir = process.env.QUALITY_RENDER_CACHE_DIR
  if (!cacheDir) return
  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.appendFileSync(path.join(cacheDir, 'events.log'), `${event}\n`) } catch { /* best effort */ }
}

/**
 * execFileSync for `kustomize build`, through the cache: same arguments, same result (stdout, thrown on failure).
 * Only a UTF-8 call without stdin input uses the cache.
 */
export function kustomizeExecFileSync(file, args, options = {}) {
  const entry = options.encoding === 'utf8' && options.input === undefined
    ? kustomizeCacheEntry(String(file), args, { cwd: options.cwd, env: options.env ?? process.env,
      caller: `execFileSync maxBuffer=${options.maxBuffer ?? 'default'}` })
    : null
  const cached = entry ? readCachedRender(entry) : null
  if (cached) { recordCacheEvent('hit'); return cached.stdout }
  const stdout = execFileSync(file, args, options)
  if (entry) { writeCachedRender(entry, { stdout, stderr: '' }); recordCacheEvent('miss') }
  return stdout
}

/**
 * run-bounded's `run` for `kustomize build`, through the cache: same arguments, same result. run-bounded itself knows
 * nothing of the cache, so every module that imports only run-bounded keeps its own small closure.
 */
export async function kustomizeRun(t, file, args = [], options = {}) {
  const { encoding = 'utf8', input, onClose } = options
  const entry = encoding === 'utf8' && input === undefined && !onClose
    ? kustomizeCacheEntry(String(file), args, { cwd: options.cwd, env: options.env ?? process.env, caller: 'run' })
    : null
  const cached = entry && !t?.signal?.aborted ? readCachedRender(entry) : null
  if (cached) {
    recordCacheEvent('hit')
    return { pid: undefined, status: 0, signal: null, stdout: cached.stdout, stderr: cached.stderr,
      output: [null, cached.stdout, cached.stderr], error: undefined }
  }
  const result = await run(t, file, args, options)
  if (entry && !result.error && result.status === 0) {
    writeCachedRender(entry, { stdout: result.stdout, stderr: result.stderr })
    recordCacheEvent('miss')
  }
  return result
}

/** run-bounded's `runOk` for `kustomize build`, through the cache. */
export async function kustomizeRunOk(t, file, args = [], options = {}) {
  return succeeded(file, args, await kustomizeRun(t, file, args, options))
}
