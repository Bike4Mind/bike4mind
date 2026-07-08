# Self-host WebSocket gateway image. Tiny: a single Node script + `ws`.
# Built by compose.selfhost.yaml as the `ws` service; see gateway.mjs.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY gateway.mjs ./

USER node
EXPOSE 3001
CMD ["node", "gateway.mjs"]
