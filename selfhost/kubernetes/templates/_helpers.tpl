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
{{- range $key := list "JWT_SECRET" "SESSION_SECRET" "SECRET_ENCRYPTION_KEY" "MEMORY_KEY_SECRET" "MINIO_ROOT_USER" "MINIO_ROOT_PASSWORD" "INTERNAL_WS_SECRET" "INTERNAL_S3_WEBHOOK_SECRET" "CHAT_COMPLETION_INTERNAL_SECRET" "AWS_ACCESS_KEY_ID" "AWS_SECRET_ACCESS_KEY" }}
  - name: {{ $key }}
    valueFrom:
      secretKeyRef:
        name: {{ $.Values.existingSecret }}
        key: {{ $key }}
{{- end }}
  - name: MONGODB_URI
    valueFrom:
{{- if .Values.externalMongo.enabled }}
      secretKeyRef:
        name: {{ .Values.existingSecret }}
        key: MONGODB_URI
{{- else }}
      configMapKeyRef:
        name: {{ .Release.Name }}-config
        key: MONGODB_URI
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
        {{- if .Values.externalMongo.enabled }}
        command -v timeout >/dev/null || { echo MongoProbeUnavailable >&2; exit 1; }
        for i in $(seq 1 60); do
          if reason=$(timeout -k 5s 15s mongosh --nodb --quiet --eval '
            try {
              const uri = process.env.MONGODB_URI;
              if (!uri) { print("MongoUriMissing"); quit(1); }
              const query = uri.includes("?") ? uri.slice(uri.indexOf("?") + 1) : "";
              const keys = new Set(query.split("&").map(option => decodeURIComponent(option.split("=")[0]).toLowerCase()));
              const options = ["serverSelectionTimeoutMS=10000", "connectTimeoutMS=10000", "socketTimeoutMS=10000"]
                .filter(option => !keys.has(option.split("=")[0].toLowerCase()));
              const separator = uri.includes("?") ? "&" : "?";
              const database = connect(uri + (options.length ? separator + options.join("&") : ""));
              if (!database.hello().isWritablePrimary) { print("MongoNotWritablePrimary"); quit(1); }
            } catch (error) {
              const names = ["MongoServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError", "MongoParseError", "MongoInvalidArgumentError", "MongoServerError"];
              print(names.includes(error?.name) ? error.name : "MongoConnectionError");
              quit(1);
            }
          ' 2>/dev/null); then exit 0; else status=$?; fi
          case "$status" in
            124|137) echo MongoProbeTimeout >&2 ;;
            *)
              case "$reason" in
                MongoUriMissing|MongoNotWritablePrimary|MongoServerSelectionError|MongoNetworkError|MongoNetworkTimeoutError|MongoParseError|MongoInvalidArgumentError|MongoServerError|MongoConnectionError) echo "$reason" >&2 ;;
                *) echo MongoConnectionError >&2 ;;
              esac
              ;;
          esac
          sleep 2
        done
        {{- else }}
        for i in $(seq 1 180); do
          mongosh "$MONGODB_URI" --quiet --eval 'if (!db.hello().isWritablePrimary) quit(1)' && exit 0
          sleep 2
        done
        {{- end }}
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
