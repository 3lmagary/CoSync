# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root workspace manifests (includes package-lock.json)
COPY package*.json ./

# Copy frontend workspace package.json
COPY frontend/package.json ./frontend/

# Install only frontend workspace dependencies (uses root package-lock.json)
RUN npm ci --workspace=frontend

# Copy frontend source
COPY frontend/ ./frontend/

# Pass backend URL at build time if needed
ARG VITE_BACKEND_URL=http://localhost:4000
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

RUN npm run build --workspace=frontend

# Production web server stage
FROM nginx:alpine

COPY --from=builder /app/frontend/dist /usr/share/nginx/html

# Custom Nginx configuration to support SPA routing (fallback to index.html)
RUN echo 'server { \
    listen 80; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html index.htm; \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
