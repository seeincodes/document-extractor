FROM node:20-slim AS base

# System dependencies for @napi-rs/canvas, LibreOffice, Tesseract, sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-core \
    libreoffice-writer \
    tesseract-ocr \
    tesseract-ocr-eng \
    libfontconfig1 \
    libpixman-1-0 \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgif7 \
    libjpeg62-turbo \
    librsvg2-2 \
    fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

# Rebuild native addons for this platform
RUN npm rebuild sharp @napi-rs/canvas

# Copy source and build
COPY . .
# postinstall was skipped by --ignore-scripts; copy pdfjs worker for react-pdf
RUN cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.mjs 2>/dev/null || true
RUN npm run build

# Non-root runtime user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
RUN chown -R appuser:appgroup /app /tmp
USER appuser

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
