{{- define "b4m.initRevision" -}}
{{- printf "%s|%s|%s" (.Files.Get "files/buckets.sh") (.Files.Get "files/default-env.yaml") (.Values | toJson) | sha256sum | trunc 8 -}}
{{- end -}}
{{- define "b4m.env" -}}
envFrom:
  - configMapRef:
      name: {{ .Release.Name }}-config
  - secretRef:
      name: {{ required "existingSecret must name an existing runtime Secret" .Values.existingSecret }}
env:
{{- range $key := list "JWT_SECRET" "SESSION_SECRET" "SECRET_ENCRYPTION_KEY" "MINIO_ROOT_USER" "MINIO_ROOT_PASSWORD" "INTERNAL_WS_SECRET" "INTERNAL_S3_WEBHOOK_SECRET" "CHAT_COMPLETION_INTERNAL_SECRET" "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY" }}
  - name: {{ $key }}
    valueFrom:
      secretKeyRef:
        name: {{ $.Values.existingSecret }}
        key: {{ $key }}
{{- end }}
{{- end -}}
{{- define "b4m.pod" -}}
automountServiceAccountToken: false
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}
{{- define "b4m.wait" -}}
initContainers:
  - name: validate-secrets
    image: {{ required "images.app is required" .Values.images.app | quote }}
    imagePullPolicy: {{ .Values.imagePullPolicy }}
    command:
      - node
      - -e
      - |
        const required = ['JWT_SECRET','SESSION_SECRET','INTERNAL_WS_SECRET','INTERNAL_S3_WEBHOOK_SECRET','CHAT_COMPLETION_INTERNAL_SECRET'];
        {{ if .Values.agentExecutor.enabled }}required.push('AGENT_EXECUTOR_INTERNAL_SECRET');{{ end }}
        for (const key of required) {
          const value = process.env[key] || '';
          if (value.length < 32 || value.startsWith('change-me')) { console.error(key + ' must be generated before installation'); process.exit(1); }
        }
        if (!/^[0-9a-fA-F]{64}$/.test(process.env.SECRET_ENCRYPTION_KEY || '')) { console.error('SECRET_ENCRYPTION_KEY must be 64 hexadecimal characters'); process.exit(1); }
        if ((process.env.MINIO_ROOT_USER || '').length < 3 || (process.env.MINIO_ROOT_PASSWORD || '').length < 16 || process.env.MINIO_ROOT_PASSWORD === 'minioadmin') { console.error('Strong object-store credentials required'); process.exit(1); }
    {{ include "b4m.env" . | nindent 4 }}
    resources: {{ .Values.resources.ws | toJson }}
  - name: wait-mongo
    image: {{ .Values.images.mongo | quote }}
    imagePullPolicy: {{ .Values.imagePullPolicy }}
    command:
      - /bin/sh
      - -ec
      - |
        for i in $(seq 1 180); do
          mongosh "$MONGODB_URI" --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' && exit 0
          sleep 2
        done
        exit 1
    {{ include "b4m.env" . | nindent 4 }}
    resources: {{ .Values.resources.backing | toJson }}
  - name: wait-buckets
    image: {{ required "images.mc is required" .Values.images.mc | quote }}
    imagePullPolicy: {{ .Values.imagePullPolicy }}
    command: [/bin/sh, -ec]
    args:
      - |
        for i in $(seq 1 180); do
          mc alias set local "http://{{ .Release.Name }}-minio:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 &&
          mc stat "local/$APP_FILES_BUCKET/.initialized-{{ include "b4m.initRevision" . }}" >/dev/null 2>&1 && exit 0
          sleep 2
        done
        exit 1
    {{ include "b4m.env" . | nindent 4 }}
    resources: {{ .Values.resources.backing | toJson }}
{{- end -}}
