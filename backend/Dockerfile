# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV DATABASE_PATH=/app/data/sync.db
ENV ENABLE_METRICS=true
ENV ENABLE_BACKUPS=true

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

EXPOSE 4000

# Create WAL and DB directories
RUN mkdir -p /app/data /app/wal

CMD ["node", "dist/index.js"]
