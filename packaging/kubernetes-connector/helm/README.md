# kubernetes-connector Helm chart

Installs Aient's Kubernetes connector and its read-only viewer for one connection, in namespace `aient`. It renders
the same objects as the Kustomize tree next to it and as the manifest Aient's attach page generates; see
[the packaging README](../README.md) for what each object does and for the optional parts.

## Install

1. Attach the cluster in Aient. Declare the viewer's RBAC: the rules of every viewer ClusterRole this chart renders
   with your values (`helm template ... --show-only templates/viewer.yaml`). Aient shows the connection ID and an
   install command once.
2. Render the chart for that connection into the file the install command applies:

   ```sh
   helm repo add aient https://aient-ai.github.io/helm-charts
   helm template kubernetes-connector aient/kubernetes-connector --version <version> \
     --namespace aient --set connection.id=<connection ID> [--values your-values.yaml] > aient-connector.yaml
   ```

   The same chart is at `oci://ghcr.io/aient-ai/charts/kubernetes-connector`.
3. Run the install command in the same directory. It generates the connector's key in the cluster, enrols its public
   key, and applies `aient-connector.yaml`.

GitOps tools that render charts (Argo CD, Flux) can deploy the chart once the install command has run. The chart never
creates the key Secret `aient-connector-key`. `helm install` releases are not supported yet: the install command
applies the rendered file itself.

## Values

| Value | Default | Meaning |
| --- | --- | --- |
| `connection.id` | (required) | The connection's ID, `kconn_` and 32 hexadecimal digits |
| `connection.brokerUrl` | `wss://kube-broker.aient.ai` | Aient's connector broker |
| `connector.image` | the released connector, by digest | Repository, tag and digest; a digest is required |
| `viewer.rules` | built-in resources without Secrets; built-in API groups whole | The core viewer role's rules |
| `logs.enabled` | `true` | The `-viewer-logs` role (`pods/log`) |
| `extraApiGroups` | `[]` | Adds the `-viewer-extra` role, reading these API groups whole |
| `namespaces` | `[]` | Binds the viewer roles only in these namespaces instead of cluster-wide |
| `networkPolicy.cilium.enabled` | `false` | A CiliumNetworkPolicy limiting HTTPS to the broker's host name and the API server |
| `connector.enabled` | `true` | Reserved: `false` (the direct path) is not available yet |
