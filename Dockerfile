# Lightweight, production-grade Node.js container for Blink Standalone Backend
FROM node:22-bookworm-slim

# Install system dependencies for native sqlite3 build and certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    build-essential \
    sqlite3 \
    libsqlite3-dev \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for Docker layer caching
COPY package*.json ./

# Install only production dependencies and compile sqlite3
RUN npm install --omit=dev --no-audit --no-fund && \
    npm rebuild sqlite3 --build-from-source

# Copy backend source code & assets
COPY . .

# Ensure standard directories exist
RUN mkdir -p /app/data /app/uploads/avatars

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

EXPOSE 3000

CMD ["node", "index.js"]
