{{/* The viewer ServiceAccount: aient-kconn-<the connection ID's hex>. Aient's attach read-back expects this name. */}}
{{- define "kubernetes-connector.viewer" -}}
{{- if not (regexMatch "^kconn_[0-9a-f]{32}$" (.Values.connection.id | toString)) -}}
{{- fail "connection.id must be the connection's ID from Aient: kconn_ and 32 hexadecimal digits" -}}
{{- end -}}
aient-kconn-{{ trimPrefix "kconn_" .Values.connection.id }}
{{- end -}}

{{/* Helm's own labels; the contract test removes them before comparing with Kustomize. */}}
{{- define "kubernetes-connector.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* The viewer roles that are enabled: name suffix and rules. */}}
{{- define "kubernetes-connector.viewerRoles" -}}
{{- $verbs := list "get" "list" "watch" -}}
{{- $roles := list (dict "suffix" "viewer" "rules" .Values.viewer.rules) -}}
{{- if .Values.extraApiGroups -}}
{{- $roles = append $roles (dict "suffix" "viewer-extra" "rules" (list (dict "apiGroups" .Values.extraApiGroups "resources" (list "*") "verbs" $verbs))) -}}
{{- end -}}
{{- if .Values.logs.enabled -}}
{{- $roles = append $roles (dict "suffix" "viewer-logs" "rules" (list (dict "apiGroups" (list "") "resources" (list "pods/log") "verbs" $verbs))) -}}
{{- end -}}
{{- toJson $roles -}}
{{- end -}}
