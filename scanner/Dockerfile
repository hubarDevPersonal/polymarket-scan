# ── Build stage ──────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npm run build

# ── Production stage ────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist/ dist/
COPY public/ public/

USER node

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://localhost:3847/api/health || exit 1

CMD ["node", "dist/index.js"]
