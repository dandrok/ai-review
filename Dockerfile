# For projects without Node: docker run --rm -v "$PWD:/repo" -w /repo ...
FROM node:20-alpine
WORKDIR /app
COPY dist ./dist
COPY packs ./packs
COPY templates ./templates
COPY package.json ./
RUN printf '#!/bin/sh\nexec node /app/dist/ai-review.mjs "$@"\n' > /usr/local/bin/ai-review && chmod +x /usr/local/bin/ai-review
# Usage: docker run --rm -v "$PWD:/repo" -w /repo -e DEEPSEEK_API_KEY ai-review review --worktree
# Needs git access to the mounted repo (the repo is mounted, so the binary inside sees it).
RUN apk add --no-cache git
WORKDIR /repo
ENTRYPOINT ["ai-review"]
