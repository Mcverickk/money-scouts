FROM node:22-alpine AS runtime

WORKDIR /app

# tsx is intentionally installed in the runtime image because this repository
# executes the TypeScript workspace sources directly. The lockfile keeps the
# resulting image reproducible.
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/ingestor/package.json apps/ingestor/package.json
COPY apps/workers/package.json apps/workers/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/scoring/package.json packages/scoring/package.json

RUN npm ci --include=dev

COPY apps/api apps/api
COPY apps/ingestor apps/ingestor
COPY apps/workers apps/workers
COPY packages packages
COPY scripts scripts

ENV NODE_ENV=production

USER node

EXPOSE 3000

CMD ["npm", "run", "start:api"]
