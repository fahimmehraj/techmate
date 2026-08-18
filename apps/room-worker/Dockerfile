FROM mcr.microsoft.com/playwright:v1.58.0-noble

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13"

ENV BUN_INSTALL=/root/.bun
ENV PATH="${BUN_INSTALL}/bin:${PATH}"
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile

CMD ["bun", "--filter", "@technyu/room-worker", "start"]
