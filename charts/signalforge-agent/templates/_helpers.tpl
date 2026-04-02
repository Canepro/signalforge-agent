{{- define "signalforge-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "signalforge-agent.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "signalforge-agent.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "signalforge-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "signalforge-agent.labels" -}}
helm.sh/chart: {{ include "signalforge-agent.chart" . }}
app.kubernetes.io/name: {{ include "signalforge-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: kubernetes-runner
{{- end -}}

{{- define "signalforge-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "signalforge-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: kubernetes-runner
{{- end -}}

{{- define "signalforge-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "signalforge-agent.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- required "serviceAccount.name is required when serviceAccount.create=false" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "signalforge-agent.clusterScopedName" -}}
{{- printf "%s-%s" (include "signalforge-agent.fullname" .) .Release.Namespace | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "signalforge-agent.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "signalforge-agent.tokenSecretName" -}}
{{- if .Values.agent.token.existingSecret -}}
{{- .Values.agent.token.existingSecret -}}
{{- else -}}
{{- printf "%s-token" (include "signalforge-agent.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "signalforge-agent.kubeconfigName" -}}
{{- printf "%s-kubeconfig" (include "signalforge-agent.fullname" .) -}}
{{- end -}}

{{- define "signalforge-agent.kubeContextAlias" -}}
{{- default "in-cluster" .Values.agent.kubeContextAlias -}}
{{- end -}}
