FROM docker.io/oven/bun:1

USER root

ARG KUBECTL_VERSION=v1.33.1
ARG TARGETARCH=amd64

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    docker.io \
    jq \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl \
  && chmod +x /usr/local/bin/kubectl

WORKDIR /opt/signalforge/signalforge-agent

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src /opt/signalforge/signalforge-agent/src
COPY signalforge-collectors /opt/signalforge/signalforge-collectors

RUN chmod +x \
    /opt/signalforge/signalforge-agent/src/cli.ts \
    /opt/signalforge/signalforge-collectors/first-audit.sh \
    /opt/signalforge/signalforge-collectors/collect-container-diagnostics.sh \
    /opt/signalforge/signalforge-collectors/collect-kubernetes-bundle.sh \
    /opt/signalforge/signalforge-collectors/submit-to-signalforge.sh \
  && addgroup --system signalforge \
  && adduser --system --ingroup signalforge --home /opt/signalforge/signalforge-agent signalforge \
  && mkdir -p /work \
  && chown -R signalforge:signalforge /opt/signalforge /work

ENV SIGNALFORGE_COLLECTORS_DIR=/opt/signalforge/signalforge-collectors
ENV SIGNALFORGE_KUBECTL_BIN=/usr/local/bin/kubectl

USER signalforge
WORKDIR /work

ENTRYPOINT ["bun", "run", "/opt/signalforge/signalforge-agent/src/cli.ts"]
CMD ["run"]
