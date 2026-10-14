FROM alpine:3.23 AS build

RUN apk update && apk -U --no-cache add go alsa-lib-dev libogg-dev libvorbis-dev flac-dev mpg123-dev gcc musl-dev

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
# Encore patch 8: the Encore release this engine is built for (--version); empty (unstamped) in a plain build
ARG ENCORE_VERSION=
RUN CGO_ENABLED=1 go build -v -ldflags "-X main.encoreVersion=${ENCORE_VERSION}" -o ./go-librespot ./cmd/daemon

FROM alpine:3.23

RUN apk update && apk -U --no-cache add libpulse avahi libgcc gcompat alsa-lib \
 && mkdir -p /usr/share/encore && apk info -v | sort > /usr/share/encore/packages.txt

COPY --from=build /src/go-librespot /usr/bin/go-librespot
# Encore patch 8: Encore's default config.yml, copied into /config at the first start (never over an existing one)
COPY encore-docker/config.yml /usr/share/encore/config.yml
COPY encore-docker/entrypoint.sh /usr/share/encore/entrypoint.sh

ENTRYPOINT ["/bin/sh", "/usr/share/encore/entrypoint.sh"]
CMD ["/usr/bin/go-librespot", "--config_dir", "/config"]
