FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --fetch-retries=5
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web --fetch-retries=5
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build:all

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --fetch-retries=5 && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 3053
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3053/api/health | grep -q '"ready":true' || exit 1
CMD ["node", "dist/main.js"]
