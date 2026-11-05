{{/*
Expand the name of the chart.
*/}}
{{- define "rowflare.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name, truncated to 63 characters (the DNS label limit).
*/}}
{{- define "rowflare.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "rowflare.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "rowflare.labels" -}}
helm.sh/chart: {{ include "rowflare.chart" . }}
{{ include "rowflare.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "rowflare.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rowflare.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "rowflare.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "rowflare.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Image reference: repository:tag, or repository:tag@digest when a digest is set.
*/}}
{{- define "rowflare.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{- printf "%s:%s@%s" .Values.image.repository $tag .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end }}

{{- define "rowflare.secretName" -}}
{{- default (include "rowflare.fullname" .) .Values.rowflare.existingSecret }}
{{- end }}

{{- define "rowflare.secretKeyName" -}}
{{- if .Values.rowflare.existingSecret }}{{ .Values.rowflare.existingSecretKey }}{{ else }}SECRET_KEY{{ end }}
{{- end }}

{{- define "rowflare.claimName" -}}
{{- default (printf "%s-data" (include "rowflare.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}
