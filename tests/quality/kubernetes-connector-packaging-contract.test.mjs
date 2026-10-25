// The two packagings of packaging/kubernetes-connector render the same objects for every variant. Plan:
// docs/plans/2026-10-20-feat-aient-readonly-cluster-view-plan.md#two-packagings-one-set-of-objects
// Needs helm and kustomize. Without helm it skips, unless AIENT_REQUIRE_HELM=1 (the packaging and release workflows).
// The release workflow also runs it against what it published: PUBLISHED_CHART (oci://<registry>/<chart>:<version> or
// https://<helm repository>:<version>) and PUBLISHED_REPO_COMMIT (a commit of github.com/aient-ai/helm-charts).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { parse, parseAllDocuments, stringify } from 'yaml'

import { coreResources, loadPolicy } from '../../infra/k8s-identity/aient-viewer/generate.mjs'
import { helm, requireHelm } from './helpers/require-helm.mjs'
import { removeTempDirectorySync } from './helpers/temp-directory-cleanup.mjs'
import { run } from './run-bounded.mjs'

const ROOT = realpathSync(resolve('packaging/kubernetes-connector'))
const CONNECTION_ID = 'kconn_0123456789abcdef0123456789abcdef'
const VIEWER = 'aient-kconn-0123456789abcdef0123456789abcdef'
const PLACEHOLDER = 'aient-kconn-00000000000000000000000000000000'
const EXTRA_GROUPS = ['cert-manager.io', 'argoproj.io']
const NAMESPACES = ['payments', 'checkout']
const READ = ['get', 'list', 'watch']
const CHART = 'kubernetes-connector'
const PUBLISHED_CHART = process.env.PUBLISHED_CHART
const PUBLISHED_REPO_COMMIT = process.env.PUBLISHED_REPO_COMMIT

const VARIANTS = {
  defaults: {},
  'without-logs': { withoutLogs: true },
  'namespace-scoped': { namespaces: true },
  'extra-api-groups': { extra: true },
  'cilium-egress': { cilium: true },
  all: { namespaces: true, extra: true, cilium: true },
  'all without logs': { withoutLogs: true, namespaces: true, extra: true, cilium: true },
}

// Kubernetes reads manifests as YAML 1.1, where defaultMode: 0440 is octal.
const documents = text => parseAllDocuments(text, { version: '1.1' }).map(doc => doc.toJS()).filter(Boolean)

async function helmRender(t, variant, extraValues = {}) {
  const values = {
    connection: { id: CONNECTION_ID },
    logs: { enabled: !variant.withoutLogs },
    extraApiGroups: variant.extra ? EXTRA_GROUPS : [],
    namespaces: variant.namespaces ? NAMESPACES : [],
    networkPolicy: { cilium: { enabled: Boolean(variant.cilium) } },
    ...extraValues,
  }
  const dir = mkdtempSync(join(tmpdir(), 'kubernetes-connector-helm-'))
  try {
    writeFileSync(join(dir, 'values.yaml'), stringify(values))
    const [source, version] = PUBLISHED_CHART ? PUBLISHED_CHART.split(/:(?=[^:/]+$)/) : [join(ROOT, 'helm')]
    const chart = /^https?:\/\//.test(source) ? [CHART, '--repo', source] : [source]
    return await run(t, helm, ['template', CHART, ...chart, ...(version ? ['--version', version] : []), '--namespace', 'aient',
      '--values', join(dir, 'values.yaml')])
  } finally {
    removeTempDirectorySync(dir)
  }
}

// The overlay the attach page generates for a connection: the base, the chosen components, connection last.
async function kustomizeBuild(t, variant) {
  // Real paths: kustomize resolves the relative path from the overlay's real directory (macOS /var → /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kubernetes-connector-overlay-')))
  try {
    const local = relative(dir, join(ROOT, 'kustomize'))
    const part = path => PUBLISHED_REPO_COMMIT
      ? `https://github.com/aient-ai/helm-charts//kustomize/${CHART}/${path}?ref=${PUBLISHED_REPO_COMMIT}` : `${local}/${path}`
    const roles = ['viewer', ...(variant.extra ? ['viewer-extra'] : []), ...(variant.withoutLogs ? [] : ['viewer-logs'])]
    const resources = [part('base')]
    if (variant.namespaces) {
      const bindings = NAMESPACES.flatMap(namespace => roles.map(role => ({
        apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding',
        metadata: { name: `${PLACEHOLDER}-${role}`, namespace },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: `${PLACEHOLDER}-${role}` },
        subjects: [{ kind: 'ServiceAccount', name: PLACEHOLDER, namespace: 'aient' }],
      })))
      writeFileSync(join(dir, 'namespace-rolebindings.yaml'), bindings.map(b => stringify(b)).join('---\n'))
      resources.push('namespace-rolebindings.yaml')
    }
    const components = [
      ...(variant.withoutLogs ? ['without-logs'] : []),
      ...(variant.extra ? ['extra-api-groups'] : []),
      ...(variant.cilium ? ['cilium-egress'] : []),
      ...(variant.namespaces ? ['namespace-scoped'] : []),
      'connection',
    ].map(name => part(`components/${name}`))
    const patches = variant.extra
      ? [{ target: { kind: 'ClusterRole', name: 'aient-kconn-.*-viewer-extra' },
          patch: stringify([{ op: 'replace', path: '/rules', value: [{ apiGroups: EXTRA_GROUPS, resources: ['*'], verbs: READ }] }]) }]
      : []
    writeFileSync(join(dir, 'kustomization.yaml'), stringify({
      apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources, components, patches,
      configMapGenerator: [{ name: 'aient-connection', namespace: 'aient', behavior: 'merge',
        options: { disableNameSuffixHash: true }, literals: [`AIENT_CONNECTION_ID=${CONNECTION_ID}`] }],
    }))
    const result = await run(t, 'kustomize', ['build', dir])
    assert.equal(result.status, 0, result.stderr)
    return documents(result.stdout)
  } finally {
    removeTempDirectorySync(dir)
  }
}

const HELM_ONLY_LABELS = ['helm.sh/chart', 'app.kubernetes.io/managed-by', 'app.kubernetes.io/version']
const key = o => [o.apiVersion, o.kind, o.metadata.namespace ?? '', o.metadata.name].join('/')

function normalise(objects) {
  return objects.map(object => {
    const copy = structuredClone(object)
    const labels = copy.metadata.labels ?? {}
    for (const label of HELM_ONLY_LABELS) delete labels[label]
    if (Object.keys(labels).length === 0) delete copy.metadata.labels
    return copy
  }).sort((a, b) => key(a).localeCompare(key(b)))
}

async function helmObjects(t, variant) {
  const result = await helmRender(t, variant)
  assert.equal(result.status, 0, result.stderr)
  return documents(result.stdout)
}

// The contract both renders must meet, whatever the variant.
function assertRoleContract(objects, variant) {
  const viewerRoles = objects.filter(o => o.kind === 'ClusterRole')
  assert.ok(viewerRoles.length > 0)
  for (const role of viewerRoles) {
    assert.ok(role.metadata.name.startsWith(`${VIEWER}-viewer`), role.metadata.name)
    for (const rule of role.rules) {
      assert.deepEqual(rule.verbs, READ, `${role.metadata.name}: read verbs only`)
      assert.ok(!rule.apiGroups.includes('*'), `${role.metadata.name}: no * API group`)
      const resources = rule.resources
      if (rule.apiGroups.includes('')) assert.ok(!resources.includes('*'), 'the core group is never read whole: it holds Secrets')
      for (const resource of resources) {
        assert.ok(!['secrets', 'serviceaccounts/token'].includes(resource), `${role.metadata.name} grants ${resource}`)
        assert.ok(!/\/(exec|attach|portforward|proxy)$/.test(resource), `${role.metadata.name} grants ${resource}`)
      }
    }
  }
  // Pod logs in every namespace the viewer is bound in, unless removed (Henrik, 2026-10-24).
  const readsLogs = viewerRoles.some(role => role.rules.some(rule => rule.resources.includes('pods/log')))
  assert.equal(readsLogs, !variant.withoutLogs)
  const viewerSa = objects.find(o => o.kind === 'ServiceAccount' && o.metadata.name !== 'aient-connector')
  assert.equal(viewerSa.metadata.name, VIEWER)
  const mint = objects.find(o => o.kind === 'Role' && o.metadata.name === 'aient-connector-mint')
  assert.deepEqual(mint.rules, [{ apiGroups: [''], resources: ['serviceaccounts/token'], resourceNames: [VIEWER], verbs: ['create'] }])
  for (const object of objects.filter(o => o.kind === 'Deployment')) {
    for (const container of object.spec.template.spec.containers) assert.match(container.image, /@sha256:[0-9a-f]{64}$/)
  }
  const bindings = objects.filter(o => ['ClusterRoleBinding', 'RoleBinding'].includes(o.kind) && o.metadata.name !== 'aient-connector-mint')
  for (const binding of bindings) assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: VIEWER, namespace: 'aient' }])
  if (variant.namespaces) {
    assert.ok(!objects.some(o => o.kind === 'ClusterRoleBinding'), 'the namespace-scoped variant binds the viewer at cluster scope')
    assert.deepEqual([...new Set(bindings.map(b => b.metadata.namespace))].sort(), [...NAMESPACES].sort())
  }
  const config = objects.find(o => o.kind === 'ConfigMap' && o.metadata.name === 'aient-connection')
  assert.equal(config.data.AIENT_CONNECTION_ID, CONNECTION_ID)
  if (variant.cilium) {
    // Kept, so that kubectl apply narrows an existing installation, but allowing nothing: its egress rule would reopen
    // HTTPS to any address, since Cilium allows what either policy allows.
    const generic = objects.find(o => o.kind === 'NetworkPolicy')
    assert.deepEqual(generic.spec.policyTypes, ['Ingress', 'Egress'])
    assert.equal(generic.spec.egress, undefined)
    assert.equal(generic.spec.ingress, undefined)
    const policy = objects.find(o => o.kind === 'CiliumNetworkPolicy')
    assert.deepEqual(policy.spec.egress.flatMap(rule => rule.toFQDNs ?? []), [{ matchName: new URL(config.data.AIENT_BROKER_URL).host }])
    assert.ok(policy.spec.egress.some(rule => rule.toEntities?.includes('kube-apiserver')))
    assert.ok(!policy.spec.egress.some(rule => rule.toEntities?.some(entity => ['world', 'all'].includes(entity)) || rule.toCIDR || rule.toCIDRSet))
  } else {
    assert.ok(!objects.some(o => o.kind === 'CiliumNetworkPolicy'))
  }
}

for (const [name, variant] of Object.entries(VARIANTS)) {
  test(`helm and kustomize render the same objects: ${name}`, async t => {
    if (!(await requireHelm(t))) return
    const fromHelm = await helmObjects(t, variant)
    const fromKustomize = await kustomizeBuild(t, variant)
    assertRoleContract(fromHelm, variant)
    assertRoleContract(fromKustomize, variant)
    assert.deepEqual(normalise(fromHelm), normalise(fromKustomize))
  })
}

test('the default viewer reads the built-in groups and core resources of the published aient-viewer template', () => {
  const policy = loadPolicy()
  const expected = [{ apiGroups: [''], resources: coreResources, verbs: READ }, { apiGroups: policy.builtinGroups, resources: ['*'], verbs: READ }]
  assert.deepEqual(parse(readFileSync(join(ROOT, 'helm/values.yaml'), 'utf8')).viewer.rules, expected)
  const base = documents(readFileSync(join(ROOT, 'kustomize/base/viewer.yaml'), 'utf8')).find(o => o.kind === 'ClusterRole')
  assert.deepEqual(base.rules, expected)
})

test('the chart refuses what it cannot install', async t => {
  if (!(await requireHelm(t))) return
  const refusals = [
    [{ connection: { id: 'kconn_NOT-HEX' } }, /connection/],
    [{ connector: { enabled: false } }, /direct path/],
    // The collector is its own chart; an unknown value is refused rather than ignored.
    [{ collector: { enabled: true } }, /collector/],
    [{ connector: { image: { repository: 'ghcr.io/aient-ai/kubernetes-connector', tag: '0.1.0', digest: 'latest' } } }, /digest/],
    [{ connection: { id: CONNECTION_ID, brokerUrl: 'wss://broker.example:8443' }, networkPolicy: { cilium: { enabled: true } } }, /port 443/],
  ]
  for (const [values, message] of refusals) {
    const result = await helmRender(t, {}, values)
    assert.notEqual(result.status, 0, JSON.stringify(values))
    assert.match(result.stderr, message)
  }
})

test('kustomize hashes the broker URL as helm does', () => {
  const base = documents(readFileSync(join(ROOT, 'kustomize/base/deployment.yaml'), 'utf8'))[0]
  const config = documents(readFileSync(join(ROOT, 'kustomize/base/configmap.yaml'), 'utf8'))[0]
  assert.equal(base.spec.template.metadata.annotations['aient.ai/broker-url'],
    createHash('sha256').update(config.data.AIENT_BROKER_URL).digest('hex'))
})
