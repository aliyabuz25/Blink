# Production-ready Node.js container for Blink Backend (Portainer & Docker optimized)
FROM node:22-bookworm-slim

# System dependencies for native modules and CA certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for Docker layer caching
COPY package*.json ./

# Install production dependencies (using precompiled binaries for speed and stability in Portainer)
RUN npm install --omit=dev --no-audit --no-fund

# Copy backend source code & assets
COPY . .

# Ensure standard directories exist and are fully writable in Portainer volume mounts
RUN mkdir -p /app/data /app/uploads/avatars && \
    chmod -R 777 /app/data /app/uploads 2>/dev/null || true

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "index.js"]
