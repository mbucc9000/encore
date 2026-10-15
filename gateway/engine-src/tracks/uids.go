package tracks

import (
	"context"
	"encoding/hex"
	"fmt"
	"hash/fnv"
	"slices"
	"strings"

	librespot "github.com/devgianlu/go-librespot"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"google.golang.org/protobuf/proto"
)

// Encore patch 9: uids for context entries that have none.
//
// Up Next names its rows by uid: an edit, Play Next and a jump all name the
// row they act on, as the same song can be in the list twice. A playlist's
// entries carry their item ids as uids, but other contexts may hand out
// entries without one, and those could not be named. So every entry the
// context hands out has one: Spotify's when it gave one, which is never
// changed, else one made up from the entry itself (contextUid): its song, the
// page it was loaded from, and how many copies of that song come before it in
// that page. Unique within the list, and without the q prefix of queued
// entries' uids (highestQueueID). A refetched page hands out the same ones.
//
// Never from its place alone: a context resolved again can hand out other
// entries in the same places (a song liked puts it at the top of Liked
// Songs), and a uid matched before the uri (ContextTrackComparator) would then
// name another song. Made from the song, a uid names that song or nothing.
//
// They stay in the engine: Spotify never had them, and is told the entries
// have none (SpotifyUid), as before patch 9.

// madeUpUidPrefix starts every uid contextUid makes.
const madeUpUidPrefix = "enc-"

// pagesWithUids is a context's pages with a uid on every entry.
type pagesWithUids struct {
	pages librespot.PageResolver[*connectpb.ContextTrack]
}

func (p pagesWithUids) Page(ctx context.Context, idx int) ([]*connectpb.ContextTrack, error) {
	tracks, err := p.pages.Page(ctx, idx)
	if err != nil {
		return tracks, err
	}
	return withUids(tracks, idx), nil
}

// withUids is the entries of page pageIdx with a uid on each one. The page's
// own entries belong to the resolver, which hands them out again when the
// page is fetched again, so an entry given a uid is a copy, in a copy of the
// page; a page whose entries all have one is handed on as it is.
func withUids(tracks []*connectpb.ContextTrack, pageIdx int) []*connectpb.ContextTrack {
	var out []*connectpb.ContextTrack
	var copies map[string]int
	for i, track := range tracks {
		if track == nil || track.Uid != "" {
			continue
		}

		if out == nil {
			out = slices.Clone(tracks)
			copies = map[string]int{}
		}
		song := entrySong(track)
		filled := proto.Clone(track).(*connectpb.ContextTrack)
		filled.Uid = contextUid(pageIdx, song, copies[song])
		copies[song]++
		out[i] = filled
	}

	if out == nil {
		return tracks
	}
	return out
}

// entrySong names the song of an entry: its uri, else its gid.
func entrySong(track *connectpb.ContextTrack) string {
	if track.Uri != "" {
		return track.Uri
	}
	return hex.EncodeToString(track.Gid)
}

// contextUid is the uid of an entry of page pageIdx the context gave none:
// enc-<page>-<song>-<n>, the song as FNV-1a 64 of entrySong, n the number of
// entries of that song before it in the page that had no uid.
func contextUid(pageIdx int, song string, n int) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(song))
	return fmt.Sprintf("%s%d-%016x-%d", madeUpUidPrefix, pageIdx, h.Sum64(), n)
}

// SpotifyUid is the uid Spotify is told an entry has: its own, or none for
// one the engine made up (contextUid), which Spotify never had.
func SpotifyUid(uid string) string {
	if strings.HasPrefix(uid, madeUpUidPrefix) {
		return ""
	}
	return uid
}
