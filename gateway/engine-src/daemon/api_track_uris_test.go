//go:build test_unit

package daemon

import (
	"testing"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/devgianlu/go-librespot/player"
	metadatapb "github.com/devgianlu/go-librespot/proto/spotify/metadata"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

func TestApiTrackCarriesAlbumAndArtistUris(t *testing.T) {
	p := &AppPlayer{app: &App{cfg: &Config{}}, prodInfo: &ProductInfo{}}

	track := p.newApiResponseStatusMedia(mediaFixture("x"), 0)
	require.Equal(t, librespot.SpotifyIdFromGid(librespot.SpotifyIdTypeAlbum, gid(0xa1)).Uri(), track.AlbumUri)
	require.Equal(t, []string{librespot.SpotifyIdFromGid(librespot.SpotifyIdTypeArtist, gid(0xa2)).Uri()}, track.ArtistUris)

	episode := p.newApiResponseStatusMedia(librespot.NewMediaFromEpisode(&metadatapb.Episode{
		Gid:        gid(0x03),
		Name:       proto.String("Episode"),
		Duration:   proto.Int32(1000),
		Show:       &metadatapb.Show{Gid: gid(0x04), Name: proto.String("Show")},
		CoverImage: &metadatapb.ImageGroup{},
	}), 0)
	require.Equal(t, librespot.SpotifyIdFromGid(librespot.SpotifyIdTypeShow, gid(0x04)).Uri(), episode.AlbumUri, "episodes name their show, like album_name")
	require.NotNil(t, episode.ArtistUris, "artist_uris must serialise as []")
	require.Empty(t, episode.ArtistUris)
}

// Explicit is the track's own flag; an episode is never marked.
func TestApiTrackExplicit(t *testing.T) {
	p := &AppPlayer{app: &App{cfg: &Config{}}, prodInfo: &ProductInfo{}}

	explicit := metaTrack(gid(0x01), "x")
	explicit.Explicit = proto.Bool(true)
	require.True(t, p.newApiResponseStatusMedia(librespot.NewMediaFromTrack(explicit), 0).Explicit)
	require.False(t, p.newApiResponseStatusMedia(mediaFixture("clean"), 0).Explicit)

	episode := p.newApiResponseStatusMedia(librespot.NewMediaFromEpisode(&metadatapb.Episode{
		Gid:        gid(0x03),
		Name:       proto.String("Episode"),
		Duration:   proto.Int32(1000),
		Show:       &metadatapb.Show{Gid: gid(0x04), Name: proto.String("Show")},
		CoverImage: &metadatapb.ImageGroup{},
	}), 0)
	require.False(t, episode.Explicit)
}

// A relinked stream plays other media than the context entry it was asked
// for: uri names the media and context_track_uri the entry, which only the
// playing track carries.
func TestApiTrackContextTrackUri(t *testing.T) {
	p := &AppPlayer{app: &App{cfg: &Config{}}, prodInfo: &ProductInfo{}}

	stream := &player.Stream{
		RequestedId: librespot.SpotifyIdFromGid(librespot.SpotifyIdTypeTrack, gid(0x05)),
		Media:       mediaFixture("relinked"),
	}
	track := p.newApiResponseStatusTrack(stream, 0)
	require.Equal(t, trackUri(0x01), track.Uri, "uri names the media that came back")
	require.Equal(t, trackUri(0x05), track.ContextTrackUri, "context_track_uri the entry it was asked for")

	require.Empty(t, p.newApiResponseStatusMedia(stream.Media, 0).ContextTrackUri, "listings and next_track name no entry")
	require.Empty(t, p.newApiResponseStatusTrack(&player.Stream{Media: stream.Media}, 0).ContextTrackUri, "an unknown entry is left out")
}

func TestGidUriToleratesMalformedGids(t *testing.T) {
	require.Equal(t, "", gidUri(librespot.SpotifyIdTypeAlbum, nil))
	require.Equal(t, "", gidUri(librespot.SpotifyIdTypeAlbum, []byte{1, 2, 3}))
}
