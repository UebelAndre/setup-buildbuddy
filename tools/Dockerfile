# Development image: the only place Node, npm and the linters need to exist.
# Build and run it through tools/dev.sh; the Node major comes from .node-version
# and must match `runs.using` in action.yml (tools/check-sync.sh checks this).
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}

ARG ACTIONLINT_VERSION=1.7.12
RUN apt-get update \
    && apt-get install -y --no-install-recommends shellcheck \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://raw.githubusercontent.com/rhysd/actionlint/v${ACTIONLINT_VERSION}/scripts/download-actionlint.bash" \
       | bash -s -- "${ACTIONLINT_VERSION}" /usr/local/bin

ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_cache=/npm-cache

WORKDIR /work
CMD ["bash"]
