#!/bin/bash
set -e

echo "═══════════════════════════════════════════════"
echo "  WebAgent Setup"
echo "═══════════════════════════════════════════════"
echo

# Check Docker
if ! command -v docker &> /dev/null; then
  echo "❌ Docker is not installed. Please install Docker first:"
  echo "   https://docs.docker.com/get-docker/"
  exit 1
fi

if ! command -v docker compose &> /dev/null && ! command -v docker-compose &> /dev/null; then
  echo "❌ Docker Compose is not installed. Please install it first."
  exit 1
fi

echo "✅ Docker found"

# Check .env
if [ ! -f .env ]; then
  echo "📝 Creating .env from .env.example..."
  cp .env.example .env
  echo
  echo "⚠️  Please edit .env and add your API key:"
  echo "   LLM_API_KEY=your_groq_api_key_here"
  echo
  read -p "Press Enter after you've added your API key..."
fi

# Verify API key is set
if grep -q "your_groq_api_key_here" .env 2>/dev/null; then
  echo "⚠️  API key not set in .env. Please edit it before continuing."
  exit 1
fi

echo "✅ .env configured"

# Build and run
echo
echo "🔨 Building Docker image..."
docker compose build

echo
echo "🚀 Starting WebAgent..."
docker compose up
