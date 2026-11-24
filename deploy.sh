#!/bin/bash
set -e

echo "🚀 [Blink Backend] Deploying PostgreSQL & Backend with Docker Compose..."

# Create host mount directories for PostgreSQL & Uploads
mkdir -p /datastore/blink/postgres_data 2>/dev/null || true
mkdir -p /datastore/blink/uploads/avatars 2>/dev/null || true

# Build and start containers in detached mode
docker compose up -d --build

echo "✅ [Blink Backend] Containers started successfully!"
echo "📡 Checking status..."
docker compose ps

echo "📋 Following logs (Press Ctrl+C to detach)..."
docker compose logs -f blink-backend
