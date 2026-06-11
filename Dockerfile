# Use Node.js 20 as parent image
FROM node:20-slim

ARG BGUTIL_POT_VERSION=1.3.1

# Install system dependencies.
# yt-dlp is installed via pip (not the standalone binary) so it can load the
# bgutil-ytdlp-pot-provider plugin — the standalone binary cannot see pip packages.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    ca-certificates && \
    curl -fsSL https://deno.land/x/install/install.sh | sh && \
    mv /root/.deno/bin/deno /usr/local/bin/deno && \
    python3 -m pip install --break-system-packages -U yt-dlp bgutil-ytdlp-pot-provider && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Build the bgutil PO token provider server. It generates the PO tokens YouTube
# now requires from datacenter IPs ("Sign in to confirm you're not a bot").
RUN curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_POT_VERSION}.tar.gz | tar xz -C /opt && \
    mv /opt/bgutil-ytdlp-pot-provider-${BGUTIL_POT_VERSION} /opt/bgutil-pot && \
    cd /opt/bgutil-pot/server && \
    npm ci && \
    npx tsc

# Set working directory
WORKDIR /app

# Create cache directory for yt-dlp
RUN mkdir -p /app/.cache && chmod 777 /app/.cache

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .
RUN chmod +x start.sh

# Expose port
EXPOSE 3000

# Start the application (updates yt-dlp, starts PO token provider, then the server)
CMD ["./start.sh"]
