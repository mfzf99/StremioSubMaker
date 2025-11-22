# 🐳 Docker Deployment Guide

## Docker Hub Image

Pre-built images are available on Docker Hub: **[xtremexq/submaker](https://hub.docker.com/r/xtremexq/submaker)**

Available tags:
- `latest` - Latest stable release (recommended)
- `1.3.3` - Specific version (for stability)

## Quick Start with Docker Compose

### Option 1: With Redis (Recommended for Production)

Uses the pre-built image from Docker Hub:

```bash
# Clone the repository (for config files)
git clone https://github.com/xtremexq/StremioSubMaker.git
cd StremioSubMaker

# Create .env file with your configuration
cp .env.example .env

# Edit .env and add your API keys
nano .env

# Start with Redis (pulls image from Docker Hub)
docker-compose up -d

# View logs
docker-compose logs -f submaker
```

### Option 2: Filesystem Storage (Local Development)

```bash
# Use the local development compose file
docker-compose -f docker-compose.local.yaml up -d
```

### Option 3: Build from Source

To build locally instead of using the Docker Hub image:

```bash
# Edit docker-compose.yaml and uncomment the 'build: .' line
# Then run:
docker-compose up --build -d
```

## Configuration

The application uses the `STORAGE_TYPE` environment variable to determine storage backend:

- **`STORAGE_TYPE=filesystem`** (default): Uses local disk storage, perfect for npm start/local development
- **`STORAGE_TYPE=redis`**: Uses Redis for distributed caching, required for HA deployments

### Redis Configuration Options

Add these to your `.env` file when using Redis:

```env
# Storage Configuration
STORAGE_TYPE=redis

# Redis Connection
REDIS_HOST=redis
REDIS_PORT=6379
# Password is optional - leave empty for no authentication (default in docker-compose.yaml)
# To enable password authentication, also update the Redis command in docker-compose.yaml
REDIS_PASSWORD=
REDIS_DB=0
REDIS_KEY_PREFIX=stremio

# API Keys
OPENSUBTITLES_API_KEY=your_opensubtitles_key
```

## Docker Run (Without Compose)

### Using Pre-built Image from Docker Hub

#### Run with Filesystem Storage

```bash
docker run -d \
  --name submaker \
  -p 7001:7001 \
  -v $(pwd)/.cache:/app/.cache \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/keys:/app/keys \
  -e STORAGE_TYPE=filesystem \
  -e OPENSUBTITLES_API_KEY=your_api_key \
  xtremexq/submaker:latest
```

#### Run with External Redis

```bash
docker run -d \
  --name submaker \
  -p 7001:7001 \
  -e STORAGE_TYPE=redis \
  -e REDIS_HOST=your-redis-host \
  -e REDIS_PORT=6379 \
  -e OPENSUBTITLES_API_KEY=your_api_key \
  xtremexq/submaker:latest
```

### Build from Source

If you want to build the image yourself:

```bash
# Clone the repository
git clone https://github.com/xtremexq/StremioSubMaker.git
cd StremioSubMaker

# Build the image
docker build -t xtremexq/submaker:custom .

# Run your custom build
docker run -d \
  --name submaker \
  -p 7001:7001 \
  -e OPENSUBTITLES_API_KEY=your_api_key \
  xtremexq/submaker:custom
```

## Troubleshooting

### Container won't start

1. Check logs: `docker-compose logs -f submaker`
2. Verify `.env` file exists and contains required keys (especially `OPENSUBTITLES_API_KEY`)
3. Ensure ports are not already in use: `lsof -i :7001`
4. Try pulling the latest image: `docker pull xtremexq/submaker:latest`

### Redis connection issues

1. Verify Redis is running: `docker-compose ps`
2. Check Redis logs: `docker-compose logs -f redis`
3. Verify `REDIS_HOST` matches your compose service name (should be `redis`)
4. Check Redis health: `docker exec stremio-redis redis-cli ping` (should return `PONG`)

### Volume permissions

If you encounter permission errors:
```bash
# Set proper ownership
sudo chown -R 1000:1000 .cache data
```

---

[← Back to README](README.md)
