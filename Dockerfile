# For projects without Node: docker run --rm -v "$PWD:/repo" -w /repo ...
# dist/ is not committed, so the bundle is built here from source.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json build.mjs ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY packs ./packs
COPY templates ./templates
COPY package.json ./
RUN printf '#!/bin/sh\nexec node /app/dist/ai-review.mjs "$@"\n' > /usr/local/bin/ai-review && chmod +x /usr/local/bin/ai-review
# Usage: docker run --rm -v "$PWD:/repo" -w /repo -e DEEPSEEK_API_KEY ai-review review --worktree
# Needs git access to the mounted repo (the repo is mounted, so the binary inside sees it).
RUN apk add --no-cache git
WORKDIR /repo
ENTRYPOINT ["ai-review"]
