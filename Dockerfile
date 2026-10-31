FROM node:24.22.2-trixie-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24.22.2-trixie-slim

WORKDIR /app

# The app runs with plain node; drop the bundled package-manager tooling.
RUN rm -rf /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
 && for p in npm npx corepack; do \
      if [ -e "/usr/local/bin/$p" ] || [ -L "/usr/local/bin/$p" ]; then \
        echo "failed to remove $p" >&2; exit 1; \
      fi; \
    done \
 && if [ -e /usr/local/lib/node_modules/npm ] || [ -e /usr/local/lib/node_modules/corepack ]; then \
      echo "failed to remove package dirs" >&2; exit 1; \
    fi

COPY --from=deps /app/node_modules ./node_modules
COPY index.js daily-override.js security.js ./

EXPOSE 10000

CMD ["node", "index.js"]
