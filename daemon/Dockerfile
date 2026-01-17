FROM golang:1.22-bookworm AS builder
WORKDIR /src

ARG GOPROXY
ARG GOSUMDB
RUN if [ -n "$GOPROXY" ]; then go env -w GOPROXY="$GOPROXY"; fi
RUN if [ -n "$GOSUMDB" ]; then go env -w GOSUMDB="$GOSUMDB"; fi
ENV GOFLAGS=-mod=mod

COPY go.mod ./
RUN go mod download

COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/elegantmc-daemon ./cmd/elegantmc-daemon

# Runtime includes Java (so mc_start works inside the container).
FROM eclipse-temurin:21-jre-jammy AS runner
WORKDIR /app

COPY --from=builder /out/elegantmc-daemon /usr/local/bin/elegantmc-daemon

ENV ELEGANTMC_BASE_DIR=/data
VOLUME ["/data"]

ENTRYPOINT ["elegantmc-daemon"]
