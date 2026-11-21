# Gradescope-only MCP server (local-mcp/gs-server.ts) for Railway.
# Build from the repo root: Railway variable RAILWAY_DOCKERFILE_PATH=local-mcp/Dockerfile
FROM oven/bun:1.2
WORKDIR /app
RUN bun add cheerio@1.2.0 zod@3.25.76 pdf-lib@1.17.1
COPY src ./src
COPY local-mcp/gs-server.ts local-mcp/gs-submit.ts local-mcp/gs-student.ts local-mcp/gs-extra.ts ./local-mcp/
CMD ["bun", "local-mcp/gs-server.ts"]
