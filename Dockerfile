# Multi-stage Dockerfile for Go 1.23 arbitrage service
# Stage 1: Build stage
FROM golang:1.23-bookworm AS builder

WORKDIR /src

# Copy dependency files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY . .

# Build the binary
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/arb-ws-server \
    ./cmd/arb-ws-server

# Stage 2: Runtime stage
FROM gcr.io/distroless/static:nonroot

# Copy binary from builder
COPY --from=builder /out/arb-ws-server /app/arb-ws-server

# Use non-root user (distroless already uses this)
USER 65532:65532

# Expose HTTP port
EXPOSE 8080

# Set entrypoint
ENTRYPOINT ["/app/arb-ws-server"]
