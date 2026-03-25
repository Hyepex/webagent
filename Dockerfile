FROM node:22-slim

# Install dependencies for Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Install Playwright Chromium
RUN npx playwright install --with-deps chromium

# Copy source
COPY src/ ./src/
COPY public/ ./public/
COPY recipes/ ./recipes/

# Run as non-root user
RUN groupadd -r agent && useradd -r -g agent -G audio,video agent \
    && mkdir -p /home/agent && chown -R agent:agent /home/agent /app
USER agent

CMD ["node", "src/server.js"]
