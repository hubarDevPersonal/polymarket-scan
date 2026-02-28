.PHONY: build test docker run clean

IMAGE ?= arb-ws:dev

# Build the Go binary locally
build:
	@echo "Building arb-ws-server..."
	go build -o bin/arb-ws-server ./cmd/arb-ws-server
	@echo "Build complete: bin/arb-ws-server"

# Run unit tests with race detector
test:
	@echo "Running tests with race detector..."
	go test -race -v ./...

# Build Docker image
docker:
	@echo "Building Docker image: $(IMAGE)"
	docker build -t $(IMAGE) .
	@echo "Docker image built: $(IMAGE)"

# Run Docker container
run:
	@echo "Running Docker container: $(IMAGE)"
	docker run -p 8080:8080 --rm $(IMAGE)

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf bin/
	@echo "Clean complete"

# Download dependencies
deps:
	@echo "Downloading dependencies..."
	go mod download
	@echo "Dependencies downloaded"

# Tidy dependencies
tidy:
	@echo "Tidying dependencies..."
	go mod tidy
	@echo "Dependencies tidied"

# Run linter (requires golangci-lint)
lint:
	@echo "Running linter..."
	golangci-lint run ./...

# Format code
fmt:
	@echo "Formatting code..."
	go fmt ./...
	@echo "Code formatted"

# Run benchmarks
bench:
	@echo "Running benchmarks..."
	go test -bench=. -benchmem ./...

# Help
help:
	@echo "Available targets:"
	@echo "  build  - Build the Go binary locally"
	@echo "  test   - Run unit tests with race detector"
	@echo "  docker - Build Docker image"
	@echo "  run    - Run Docker container"
	@echo "  clean  - Clean build artifacts"
	@echo "  deps   - Download dependencies"
	@echo "  tidy   - Tidy dependencies"
	@echo "  lint   - Run linter"
	@echo "  fmt    - Format code"
	@echo "  bench  - Run benchmarks"
