# Build helpers for the Go relay.
#
#   make run                 # run locally on :4100
#   make build               # native binary -> ./bin/relay
#   make build-linux         # static linux/amd64 -> ./bin/relay-linux-amd64
#   make build-linux-arm64   # static linux/arm64 -> ./bin/relay-linux-arm64

BIN := bin
LDFLAGS := -s -w

.PHONY: run build build-linux build-linux-arm64 clean test vet

run:
	go run .

build:
	go build -ldflags='$(LDFLAGS)' -o $(BIN)/relay .

# CGO disabled => fully static binary (no libc), runs on any Linux incl. Alpine.
build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags='$(LDFLAGS)' -o $(BIN)/relay-linux-amd64 .

build-linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags='$(LDFLAGS)' -o $(BIN)/relay-linux-arm64 .

vet:
	go vet ./...

clean:
	rm -rf $(BIN) data
