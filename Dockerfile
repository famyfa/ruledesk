# RuleDeck: single container (server + built web app).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/mock-opnsense/package.json apps/mock-opnsense/
COPY packages/core/package.json packages/core/
COPY packages/opnsense-client/package.json packages/opnsense-client/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production \
    RULEDECK_HOST=0.0.0.0 \
    RULEDECK_PORT=3000 \
    RULEDECK_DATA_DIR=/data \
    RULEDECK_WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/mock-opnsense/package.json apps/mock-opnsense/
COPY packages/core/package.json packages/core/
COPY packages/opnsense-client/package.json packages/opnsense-client/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages ./packages
COPY apps/server/src ./apps/server/src
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
