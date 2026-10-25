// For tests that need helm (HELM_BIN, default `helm`). Call requireHelm first in the test, with its context: it
// returns true when helm runs; otherwise it skips the test, or fails it when AIENT_REQUIRE_HELM=1, as the packaging
// and release workflows set.
import assert from 'node:assert/strict'

import { run } from '../run-bounded.mjs'

export const helm = process.env.HELM_BIN ?? 'helm'

export async function requireHelm(t) {
  if ((await run(t, helm, ['version', '--short'])).status === 0) return true
  assert.notEqual(process.env.AIENT_REQUIRE_HELM, '1', `${helm} is required (AIENT_REQUIRE_HELM=1)`)
  t.skip('Helm is not installed; the packaging workflow runs this with AIENT_REQUIRE_HELM=1')
  return false
}
