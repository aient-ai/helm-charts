# Aient Helm charts and Kustomize trees

What you install in your Kubernetes cluster for Aient. This repository is written only by its release workflow, which a
reviewer approves for each release: every chart release is a signed tag `<chart>-<version>` on `main`, and the
`gh-pages` branch is the Helm repository. The `source` branch holds what each release is built from.

| Chart | What it does | Guide |
| --- | --- | --- |
| `kubernetes-connector` | Lets Aient's agents read your cluster through an outbound-only connector and a read-only viewer | [Kubernetes connections](https://docs.aient.ai/ai-tools/kubernetes-connections) |

## Helm

```sh
helm repo add aient https://aient-ai.github.io/helm-charts
helm template kubernetes-connector aient/kubernetes-connector --version <version> --namespace aient \
  --set connection.id=<connection ID> > aient-connector.yaml
```

Each chart is also published as `oci://ghcr.io/aient-ai/charts/<chart>`. The chart's README, in `charts/<chart>`, lists
its values.

## Kustomize

`kustomize/<chart>` holds the same objects as the chart: a base and components. Start from
`kustomize/<chart>/examples/connection`, and point it at a commit of this repository, not a tag:

```yaml
resources:
- https://github.com/aient-ai/helm-charts//kustomize/kubernetes-connector/base?ref=<commit>
components:
- https://github.com/aient-ai/helm-charts//kustomize/kubernetes-connector/components/connection?ref=<commit>
```

## Verify

Everything is signed keyless with Sigstore by this repository's release workflow,
`https://github.com/aient-ai/helm-charts/.github/workflows/release.yml`, run on `main`:

```sh
identity=https://github.com/aient-ai/helm-charts/.github/workflows/release.yml@refs/heads/main
issuer=https://token.actions.githubusercontent.com
# The OCI chart:
cosign verify ghcr.io/aient-ai/charts/kubernetes-connector:<version> --certificate-identity "$identity" --certificate-oidc-issuer "$issuer"
# The package from the Helm repository, with the bundle published next to it:
cosign verify-blob kubernetes-connector-<version>.tgz --bundle kubernetes-connector-<version>.tgz.sigstore.json \
  --certificate-identity "$identity" --certificate-oidc-issuer "$issuer"
# The tag:
gitsign verify-tag kubernetes-connector-<version> --certificate-identity "$identity" --certificate-oidc-issuer "$issuer"
```

Each package also has a SLSA build-provenance bundle, `<chart>-<version>.tgz.provenance.sigstore.json`.

## License

Apache-2.0; see [LICENSE](LICENSE).
