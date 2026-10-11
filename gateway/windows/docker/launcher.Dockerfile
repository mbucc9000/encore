# Build image for the Encore Bridge launcher ("Encore Bridge.exe"): a pure-Go cross-compile for windows/amd64 (no cgo,
# no C toolchain). It holds only the toolchain; the source is mounted at build time (see ../build.sh).
#   docker build -t encore-winbuild-launcher:1 -f launcher.Dockerfile .
# The base image is pinned by digest, Go by version (GOTOOLCHAIN=local: never download another toolchain), and
# go-winres (icon, manifest and version resources) by version, so a rebuild gives the same exe.
FROM golang:1.25.10-bookworm@sha256:154bd7001b6eb339e88c964442c0ad6ed5e53f09844cc818a41ce4ecb3ce3b43
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-trimpath
RUN go install github.com/tc-hib/go-winres@v0.3.3 && go clean -cache
WORKDIR /work
