# Multi-stage build for the single-binary Go relay.
#
# The output is a fully static binary (CGO_ENABLED=0, pure-Go sqlite driver), so
# the final image is `distroless/static` — no shell, no libc, ~2 MB over the
# binary. Build context is this directory (apps/relay-go), which is a
# self-contained Go module.
#
#   docker build -t sbt-relay apps/relay-go
#   docker run -p 4100:4100 -v sbt-relay-data:/data sbt-relay

FROM golang:1.25-alpine AS build
WORKDIR /src

# Cache module downloads separately from source so deps only re-fetch on go.mod
# changes.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Matches the Makefile's build-linux target: static, stripped. TARGETARCH is set
# automatically by buildkit for multi-arch builds (amd64 / arm64).
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH:-amd64} \
    go build -ldflags='-s -w' -o /relay .

# Pre-create the data dir owned by the distroless nonroot uid (65532). A fresh
# Docker *named volume* inherits the ownership of the image's mountpoint, so this
# is what lets the non-root process write to the volume without an entrypoint
# chown (distroless has no shell to run one).
RUN mkdir -p /data && chown -R 65532:65532 /data

FROM gcr.io/distroless/static-debian12:nonroot
# Encrypted ciphertext only; see the package threat model. Data lives on a
# volume so it survives container replacement.
ENV RELAY_DATA_DIR=/data
EXPOSE 4100
COPY --from=build /relay /relay
COPY --from=build --chown=65532:65532 /data /data
VOLUME ["/data"]
USER nonroot
ENTRYPOINT ["/relay"]
