import { rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

const EAGAIN_RETRY_LIMIT = 8
const EAGAIN_RETRY_DELAY_MS = 25

function errorCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined
  }
  return typeof error.code === "string" ? error.code : undefined
}

export async function removeDirectory(
  directory,
  { remove = rm, sleep = delay } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await remove(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: EAGAIN_RETRY_DELAY_MS,
      })
      return
    } catch (error) {
      if (errorCode(error) !== "EAGAIN" || attempt >= EAGAIN_RETRY_LIMIT) {
        throw error
      }
      await sleep(EAGAIN_RETRY_DELAY_MS * (attempt + 1))
    }
  }
}

// The same policy for synchronous callers (a `finally` block or a `t.after` hook in a synchronous
// test). Waits between attempts with Atomics.wait, which blocks this thread only.
function sleepSync(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}

export function removeDirectorySync(
  directory,
  { remove = rmSync, sleep = sleepSync } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: EAGAIN_RETRY_DELAY_MS,
      })
      return
    } catch (error) {
      if (errorCode(error) !== "EAGAIN" || attempt >= EAGAIN_RETRY_LIMIT) {
        throw error
      }
      sleep(EAGAIN_RETRY_DELAY_MS * (attempt + 1))
    }
  }
}
