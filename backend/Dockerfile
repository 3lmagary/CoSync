# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace manifests (includes package-lock.json)
COPY package*.json ./

# Copy backend workspace package.json and tsconfig
COPY backend/package.json ./backend/
COPY backend/tsconfig.json ./backend/

# Install only backend workspace dependencies (uses root package-lock.json)
RUN npm ci --workspace=backend

# Copy backend source
COPY backend/src ./backend/src

RUN npm run build --workspace=backend

# Production stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV DATABASE_PATH=/app/data/sync.db
ENV ENABLE_METRICS=true
ENV ENABLE_BACKUPS=true

COPY package*.json ./
COPY backend/package.json ./backend/

RUN npm ci --workspace=backend --omit=dev

COPY --from=builder /app/backend/dist ./dist

EXPOSE 4000

# Create WAL and DB directories
RUN mkdir -p /app/data /app/wal

CMD ["node", "dist/index.js"]
