FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Set the working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
# We use 'ci' for faster, reliable installs in production
RUN npm ci

# Copy the rest of the app code
COPY . .

# Expose the port
EXPOSE 7000

# Set environment variables
ENV PORT=7000
ENV NODE_ENV=production
# This ensures Puppeteer finds the internal Chrome browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Start the server
CMD [ "node", "server.js" ]