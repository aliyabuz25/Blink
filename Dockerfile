# Production-ready Node.js container for Blink Backend (PostgreSQL Mandatory)
FROM node:22-bookworm-slim

# System certificates and curl for healthchecks
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for Docker layer caching
COPY package*.json ./

# Install production dependencies (Pure JavaScript - 0 native C++ compile steps)
RUN npm install --omit=dev --no-audit --no-fund

# Copy backend source code & assets
COPY . .

# Ensure upload directory exists and is writable
RUN mkdir -p /app/uploads/avatars && \
    chmod -R 777 /app/uploads 2>/dev/null || true

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "index.js"]
