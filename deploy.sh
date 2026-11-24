#!/bin/bash
set -e

echo "🚀 [Blink Backend] Deploying container with Docker Compose..."

# Create host mount directories if they do not exist
mkdir -p /datastore/blink/uploads/avatars 2>/dev/null || true
mkdir -p /datastore/blink/data 2>/dev/null || true

# Build and start container in detached mode
docker compose up -d --build

echo "✅ [Blink Backend] Container started successfully!"
echo "📡 Checking status..."
docker compose ps

echo "📋 Following logs (Press Ctrl+C to detach)..."
docker compose logs -f blink-backend
