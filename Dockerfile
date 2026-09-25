FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npm run build && npm prune --omit=dev

FROM node:22.22.0-bookworm-slim AS app
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 DATA_FILE=/data/pdm.sqlite KEY_FILE=/run/secrets/encryption-key BOOTSTRAP_FILE=/run/secrets/bootstrap-token DOCKER_ENDPOINT=http://docker-reader:2375
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/server/main.js"]

FROM node:22.22.0-bookworm-slim AS gateway
WORKDIR /app
COPY scripts/docker-gateway.mjs ./
ENV NODE_ENV=production
CMD ["node","docker-gateway.mjs"]
