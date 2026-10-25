// Run a child process from inside a node:test test, bounded only by the test runner.
//
// spawnSync, execSync and execFileSync block the event loop, so the runner's --test-timeout can
// neither fail the test nor stop the child; a per-call `timeout:` was the only bound, and it is a
// second clock that fails on a busy machine. On 2026-10-12 three contracts died at their 5 s limit
// at a load average of 14 to 28 while their work took 5.03 s.
//
// Here the child gets the test's abort signal. When the runner times the test out or cancels it,
// node:test aborts that signal and the child is killed. Nothing else bounds it, by design: where
// the runner has no --test-timeout, the CI job's own limit does. A call that must assert on a
// timeout of its own keeps spawnSync with an inline `// timeout-asserted: <why>` marker
// (contract: bounded-spawn-contract.test.mjs).
//
// Call these inside a test, not at module level or in a before hook: a hook's signal is not
// aborted when the run times out (measured 2026-10-12).
import { spawn } from 'node:child_process'

function contextSignal(t) {
  if (!(t?.signal instanceof AbortSignal)) {
    throw new TypeError('run-bounded: pass the test context as the first argument, from inside a test')
  }
  return t.signal
}

// Like spawnSync: resolves { pid, status, signal, stdout, stderr, output, error } and never rejects
// for a non-zero exit. `error` is set when the program could not be started (ENOENT and the like).
// Rejects only when the test's signal aborts.
export function run(t, file, args = [], options = {}) {
  const signal = contextSignal(t)
  if ('timeout' in options) throw new TypeError('run-bounded: the test runner bounds this call; drop `timeout`')
  const { input, encoding = 'utf8', stdio: _ignored, onClose, ...spawnOptions } = options
  return new Promise((resolve, reject) => {
    const stdout = []
    const stderr = []
    let child
    try {
      child = spawn(file, args, { ...spawnOptions, signal, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      const empty = decode([], encoding)
      resolve({ pid: undefined, status: null, signal: null, stdout: empty, stderr: empty, output: [null, empty, empty], error })
      return
    }
    let startError
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.stdin.on('error', () => {}) // a child that exits without reading its input
    child.on('error', error => {
      if (signal.aborted) reject(signal.reason ?? error)
      else startError = error
    })
    child.on('close', (status, exitSignal) => {
      // Abort rejects the result before process exit. Lifecycle owners may separately await close.
      onClose?.({ pid: child.pid, status, signal: exitSignal })
      if (signal.aborted) return
      const out = decode(stdout, encoding)
      const err = decode(stderr, encoding)
      resolve({
        pid: child.pid,
        status: startError ? null : status,
        signal: exitSignal,
        stdout: out,
        stderr: err,
        output: [null, out, err],
        error: startError,
      })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

// Like execFileSync: resolves stdout, and rejects with an error carrying status, signal, stdout
// and stderr when the program fails or exits non-zero.
export async function runOk(t, file, args = [], options = {}) {
  const result = await run(t, file, args, options)
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : `exit ${result.status ?? result.signal}`
    const error = new Error(`${file} ${args.join(' ')}: ${detail}\n${result.stderr}`)
    Object.assign(error, { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr })
    throw error
  }
  return result.stdout
}

// Like execSync: runs a command line with /bin/sh -c.
export function sh(t, command, options = {}) {
  return runOk(t, '/bin/sh', ['-c', command], options)
}

function decode(chunks, encoding) {
  const buffer = Buffer.concat(chunks)
  return encoding === 'buffer' || encoding === null ? buffer : buffer.toString(encoding)
}
