#!/usr/bin/env node
// Generates infra/k8s-identity/base/aient-viewer.yaml from policy.yaml and every CustomResourceDefinition in the
// repository. Usage: node infra/k8s-identity/aient-viewer/generate.mjs [--write]
//
// aient-viewer reads what `view` reads minus Secret-bearing resources, plus cluster-scope objects, plus every
// operator API group. Verbs are always get, list and watch. Plan: docs/plans/2026-10-20-feat-aient-readonly-
// cluster-view-plan.md (#the-aient-viewer-role).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, parseAllDocuments, stringify } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(here, '../../..')
export const outputPath = join(repoRoot, 'infra/k8s-identity/base/aient-viewer.yaml')
const verbs = ['get', 'list', 'watch']

// Core resources, listed one by one because Secrets live in the same group. pods/log is the separate
// aient-viewer-logs role; exec, attach, port-forward, proxy, tokens and Secrets are never granted.
export const coreResources = [
  'componentstatuses', 'configmaps', 'endpoints', 'events', 'limitranges',
  'namespaces', 'namespaces/status', 'nodes', 'nodes/status',
  'persistentvolumeclaims', 'persistentvolumeclaims/status', 'persistentvolumes', 'persistentvolumes/status',
  'pods', 'pods/status', 'podtemplates', 'replicationcontrollers', 'replicationcontrollers/scale', 'replicationcontrollers/status',
  'resourcequotas', 'resourcequotas/status', 'serviceaccounts', 'services', 'services/status',
]

export function loadPolicy() {
  return parse(readFileSync(join(here, 'policy.yaml'), 'utf8'))
}

function documentsOf(path, text) {
  if (path.endsWith('.json')) return [JSON.parse(text)]
  return parseAllDocuments(text).map(doc => doc.toJSON())
}

// Every CRD a tracked manifest defines, by API group: { group: { plural: [subresources] } }.
export function repositoryCrdGroups(root = repoRoot) {
  const files = execFileSync('git', ['ls-files', '-z', '*.yaml', '*.yml', '*.json'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean)
  const groups = {}
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    if (!/"?kind"?:\s*"?CustomResourceDefinition/.test(text)) continue
    let documents
    try {
      documents = documentsOf(file, text)
    } catch {
      continue // a templated file that is not plain YAML defines no installable CRD
    }
    const stack = [...documents]
    while (stack.length > 0) {
      const doc = stack.pop()
      if (!doc || typeof doc !== 'object') continue
      if (Array.isArray(doc.items)) stack.push(...doc.items)
      if (doc.kind !== 'CustomResourceDefinition' || typeof doc.spec?.group !== 'string') continue
      const subresources = new Set()
      for (const version of doc.spec.versions ?? []) {
        for (const name of Object.keys(version.subresources ?? {})) subresources.add(name)
      }
      groups[doc.spec.group] ??= {}
      groups[doc.spec.group][doc.spec.names.plural] = [...subresources].sort()
    }
  }
  return groups
}

// The decision for every group: granted whole, granted resource by resource (when a resource is denied), or
// excluded. Throws when a repository CRD group is neither granted nor excluded: a new operator's API is never granted
// without someone deciding it can be read.
export function decide(policy, crdGroups) {
  const builtin = new Set(policy.builtinGroups)
  const grantedGroups = new Set(policy.grantedGroups ?? [])
  const excluded = policy.excludedGroups ?? {}
  const denied = policy.deniedResources ?? {}
  const liveOnly = policy.liveOnlyGroups ?? {}
  const deniedByGroup = {}
  for (const id of Object.keys(denied)) {
    const at = id.lastIndexOf('/')
    const group = id.slice(0, at)
    ;(deniedByGroup[group] ??= new Set()).add(id.slice(at + 1))
  }
  const whole = [...builtin]
  const explicit = []
  for (const group of [...new Set([...Object.keys(crdGroups), ...Object.keys(liveOnly)])].sort()) {
    if (group in excluded) continue
    if (builtin.has(group)) throw new Error(`${group} is both a built-in group and a CRD group`)
    if (group in crdGroups && !grantedGroups.has(group)) {
      throw new Error(`${group} has no aient-viewer decision: add it to grantedGroups or excludedGroups in policy.yaml`)
    }
    const deny = deniedByGroup[group] ?? new Set()
    if (group in liveOnly && !(group in crdGroups)) {
      const resources = liveOnly[group].resources
      if (resources === '*' && deny.size === 0) whole.push(group)
      else if (Array.isArray(resources)) explicit.push({ group, resources: resources.filter(resource => !deny.has(resource.split('/')[0])) })
      else throw new Error(`${group}: a live-only group with a denied resource must list its resources`)
      continue
    }
    if (deny.size === 0) {
      whole.push(group)
      continue
    }
    const resources = []
    for (const [plural, subresources] of Object.entries(crdGroups[group]).sort(([a], [b]) => a.localeCompare(b))) {
      if (deny.has(plural)) continue
      resources.push(plural, ...subresources.map(sub => `${plural}/${sub}`))
    }
    explicit.push({ group, resources })
  }
  for (const group of grantedGroups) {
    if (!(group in crdGroups)) throw new Error(`granted group ${group} is defined by no CRD in the repository`)
    if (group in excluded) throw new Error(`${group} is both granted and excluded`)
  }
  for (const group of Object.keys(deniedByGroup)) {
    if (!(group in crdGroups) && !(group in liveOnly)) throw new Error(`denied resource in unknown group ${group}`)
  }
  return { whole: whole.sort(), explicit }
}

export function render(policy = loadPolicy(), crdGroups = repositoryCrdGroups()) {
  const { whole, explicit } = decide(policy, crdGroups)
  const reasons = entries => Object.entries(entries ?? {}).map(([id, reason]) => `#   ${id}: ${reason}`).join('\n')
  const viewer = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: {
      name: 'aient-viewer',
      annotations: {
        'aient.ai/viewer-excluded-groups': Object.keys(policy.excludedGroups ?? {}).sort().join(','),
        'aient.ai/viewer-denied-resources': Object.keys(policy.deniedResources ?? {}).sort().join(','),
      },
    },
    rules: [
      { apiGroups: [''], resources: coreResources, verbs },
      { apiGroups: whole, resources: ['*'], verbs },
      ...explicit.map(({ group, resources }) => ({ apiGroups: [group], resources, verbs })),
    ],
  }
  const logs = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'ClusterRole',
    metadata: { name: 'aient-viewer-logs' },
    rules: [{ apiGroups: [''], resources: ['pods/log'], verbs }],
  }
  // No YAML aliases: customers paste this file into the attach flow, whose parser resolves none.
  return [
    `# Generated by ${relative(repoRoot, fileURLToPath(import.meta.url))} from policy.yaml and the repository's CRDs.`,
    '# Do not edit: change policy.yaml and run the generator with --write.',
    '#',
    '# Excluded API groups:',
    reasons(policy.excludedGroups),
    '# Denied resources (their spec or status can carry secret material):',
    reasons(policy.deniedResources),
    stringify(viewer, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd(),
    '---',
    '# On-demand pod logs, bound separately so a role without them stays possible.',
    stringify(logs, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd(),
    '',
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = render()
  if (process.argv.includes('--write')) writeFileSync(outputPath, output)
  else process.stdout.write(output)
}
