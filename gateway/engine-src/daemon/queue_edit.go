package daemon

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"net/http"
	"slices"

	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"github.com/devgianlu/go-librespot/tracks"
)

// Up Next edits: removing a row that plays next, or moving it within its
// section, as this device's own change to its own track list. Nothing is sent
// to Spotify for it: the edit is made the way a controller's set_queue changes
// the list, on the loader lane, and committed as set_queue commits, so the new
// upcoming tracks go out in the usual connect-state push, the queue event
// follows, and a stream prefetched under the old order is never played.
//
// Queued rows go back through the list's SetQueue, as set_queue's do. The
// context's own rows cannot: set_queue's order for them is only a hint for the
// one publish it makes, and playback, the prefetch and every later publish
// walk the context in its own order, so a removed song would come back and
// play. They are edited in the list itself (List.RemoveAhead, List.MoveAhead).
//
// Rows are named by uid, never by uri: the same song can be in the list twice.
// Each edit names the revision of the rows the client was shown, and is
// refused when they have changed since, rather than applied to a list nobody
// saw.
//
// Nor is an edit of the context's rows applied while those rows are shown in a
// controller's set_queue order (nextHinted) that is not the list's own: the
// list has another order, and may not hold a row the controller moved out of
// the queue at all. A controller that only reordered or removed queued rows
// lists the context's rows as this device published them, and an edit of
// those goes through. A refused edit, and one whose row is gone when its job
// runs, is answered 409 only once the list's own rows are published: what the
// client fetches then is what an edit applies to, so the refusal does not
// repeat against the rows it was made for.

// maxQueueUid bounds the uid an edit names, and the uid of the row a move
// puts it before.
const maxQueueUid = 128

const (
	queueSectionQueue   = "queue"
	queueSectionContext = "context"
)

// errQueueRowGone reports an edit whose row, or the row it was to precede, is
// no longer where it was when the edit was taken.
var errQueueRowGone = errors.New("the row is no longer upcoming")

// errQueueUnflagged reports a queued entry that does not say it is queued.
// SetQueue keeps the entries before the first such one and drops the rest, so
// the queue is left alone. Every queued entry is flagged when it is queued.
var errQueueUnflagged = errors.New("a queued entry is not flagged as queued")

// errQueueHinted reports an edit of the context's rows made against a
// controller's set_queue order of them, which the list does not have.
var errQueueHinted = errors.New("the rows shown were a controller's order, not the list's")

// pastQueue names the rows after the queue, each by its section and
// queueRowKey, in order.
func pastQueue(next []*connectpb.ProvidedTrack) []string {
	var rows []string
	for _, track := range next {
		if track.Provider != queueSectionQueue {
			rows = append(rows, track.Provider+" "+queueRowKey(track))
		}
	}
	return rows
}

// listsOwnOrder reports whether rows shown past the queue (pastQueue) are, in
// that order, the first of those the list itself puts there: what a client
// shown them sees is then what an edit of them does to the list. Fewer is
// fine, as a controller may send fewer; more is not.
func listsOwnOrder(ctx context.Context, list *tracks.List, shown []string) bool {
	own := pastQueue(list.NextTracks(ctx, nil))
	return len(shown) <= len(own) && slices.Equal(shown, own[:len(shown)])
}

// queueEditRepublishes reports whether an edit refused for this reason
// publishes the list's own rows before it answers: those refused because the
// rows the client was shown are not, or are no longer, the list's.
func queueEditRepublishes(err error) bool {
	return errors.Is(err, tracks.ErrNotAhead) || errors.Is(err, errQueueRowGone) ||
		errors.Is(err, errQueueUnflagged) || errors.Is(err, errQueueHinted)
}

// publishedNext is what the state says plays next, as /player/queue describes
// it: at most tracks.MaxTracksInContext entries.
func (p *AppPlayer) publishedNext() []*connectpb.ProvidedTrack {
	next := p.state.player.NextTracks
	if len(next) > tracks.MaxTracksInContext {
		next = next[:tracks.MaxTracksInContext]
	}
	return next
}

// queueRowKey names an entry for the revision: its uid, or its uri when it has
// none.
func queueRowKey(track *connectpb.ProvidedTrack) string {
	if track == nil {
		return ""
	} else if track.Uid != "" {
		return track.Uid
	}
	return track.Uri
}

// queueRev is the revision of what plays now and next: FNV-1a 64 over the
// current entry and the published upcoming ones, each by queueRowKey, in
// order, one per line, as 16 lowercase hex digits. It changes when a row is
// added, removed or moved, or the song changes, and not when only metadata
// does.
func (p *AppPlayer) queueRev() string {
	h := fnv.New64a()
	_, _ = io.WriteString(h, queueRowKey(p.state.player.Track))
	for _, track := range p.publishedNext() {
		_, _ = io.WriteString(h, "\n")
		_, _ = io.WriteString(h, queueRowKey(track))
	}
	return fmt.Sprintf("%016x", h.Sum64())
}

// findQueueRow finds the first published row whose uid is uid, of the given
// section unless that is empty, other than skip. -1 when there is none.
func findQueueRow(next []*connectpb.ProvidedTrack, uid, section string, skip int) int {
	for i, track := range next {
		if i != skip && track.Uid == uid && (section == "" || track.Provider == section) {
			return i
		}
	}
	return -1
}

// queueEditError turns what stopped an edit into the API's answer: 409 when
// the rows changed under it, 400 for a shuffled context, 204 with no list.
func queueEditError(err error) error {
	switch {
	case errors.Is(err, ErrNoContext):
		return ErrNoSession
	case errors.Is(err, ErrSuperseded):
		return &apiError{kind: ErrConflict, err: err}
	case queueEditRepublishes(err):
		return &apiError{kind: ErrConflict, err: err}
	case errors.Is(err, tracks.ErrShuffledContext):
		return &apiError{kind: ErrBadRequest, err: err}
	default:
		return err
	}
}

// queueEditStatus is the status an edit's answer goes out with, for the log.
func queueEditStatus(err error) int {
	switch {
	case err == nil:
		return http.StatusOK
	case errors.Is(err, ErrNoSession):
		return http.StatusNoContent
	case errors.Is(err, ErrConflict):
		return http.StatusConflict
	case errors.Is(err, ErrBadRequest):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

// logQueueEdit logs an edit's outcome, with no uid or uri.
func (p *AppPlayer) logQueueEdit(op, section string, err error) {
	p.app.log.Infof("queue edit %s %s -> %d", op, section, queueEditStatus(err))
}

// queueEdit answers /player/queue/remove and /player/queue/move. What can be
// checked against the rows the client was shown is checked here, on the
// player loop; the edit itself runs as a list job, which answers.
func (p *AppPlayer) queueEdit(req ApiRequest) (any, error) {
	data := req.Data.(ApiRequestDataQueueEdit)
	move := req.Type == ApiRequestTypeQueueMove
	op := "remove"
	if move {
		op = "move"
	}

	if p.state.tracks == nil {
		p.logQueueEdit(op, "none", ErrNoSession)
		return nil, ErrNoSession
	}

	next := p.publishedNext()
	row := findQueueRow(next, data.Uid, "", -1)
	section := "none"
	if row >= 0 {
		section = next[row].Provider
	}

	refuse := func(kind error, why string) (any, error) {
		err := &apiError{kind: kind, err: fmt.Errorf("queue edit refused: %s", why)}
		p.logQueueEdit(op, section, err)
		return nil, err
	}

	switch {
	case data.Rev != p.queueRev():
		return refuse(ErrConflict, "what plays next changed")
	case row < 0:
		return refuse(ErrConflict, "the row is not upcoming")
	case section != queueSectionQueue && section != queueSectionContext:
		return refuse(ErrBadRequest, "only queued rows and the context's own can be edited")
	case move && data.Before == data.Uid:
		return refuse(ErrBadRequest, "a row cannot precede itself")
	case move && data.Before != "" && findQueueRow(next, data.Before, section, row) < 0:
		if findQueueRow(next, data.Before, "", row) >= 0 {
			return refuse(ErrBadRequest, "rows only move within their own section")
		}
		return refuse(ErrConflict, "the row to precede is not upcoming")
	case section == queueSectionContext && p.state.player.Options.GetShufflingContext():
		return refuse(ErrBadRequest, "the context is shuffled")
	}

	// How many rows of the section the client was shown: a move to the end
	// of the section goes after the last of those.
	span := 0
	for _, track := range next {
		if track.Provider == section {
			span++
		}
	}

	// The context's rows in a controller's order: unless that is the list's
	// own, the job edits nothing, and only publishes the list's own rows to
	// refuse it with.
	hinted := section == queueSectionContext && p.nextHinted
	var shown []string
	if hinted {
		shown = pastQueue(next)
	}

	// Why the job refused the edit, for the commit to answer once the list's
	// own rows are published. Written on the lane, and read by the commit,
	// which runs after the lane has handed its result back.
	var refused error

	reply := apiReply(req)
	p.listJobReply("queue edit", classMutate, nil, reply,
		func(ctx context.Context, list *tracks.List) error {
			var err error
			switch {
			case hinted && !listsOwnOrder(ctx, list, shown):
				err = errQueueHinted
			case section == queueSectionQueue:
				err = editQueue(list, move, data.Uid, data.Before, span)
			case move:
				err = list.MoveAhead(data.Uid, data.Before, span)
			default:
				err = list.RemoveAhead(data.Uid)
			}

			// Each of these leaves the list as it was. Answering the walk
			// with no error has listJob take the snapshot to publish.
			if queueEditRepublishes(err) {
				refused = err
				return nil
			}
			return err
		},
		func(p *AppPlayer, snap *tracks.Snapshot, err error) {
			if err == nil && refused != nil {
				// The list did not change, so what plays next and any
				// stream prefetched for it still hold. Only what is
				// published does: the list's own rows, which the client
				// fetches on the 409 and its next edit is checked against.
				p.publishUpcoming(snap)
				p.updateState()
				err = refused
			}

			if err != nil {
				err = queueEditError(err)
				p.logQueueEdit(op, section, err)
				reply.done(nil, err)
				return
			}

			// set_queue's commit (setQueue), as it is.
			p.publishUpcoming(snap)

			// The upcoming track may have changed: a stream prefetched under
			// the old plan must not be switched or faded into.
			p.invalidateUpcoming()
			p.schedulePrefetchNext()
			p.updateState()

			p.logQueueEdit(op, section, nil)
			reply.done(&ApiQueueRevision{Rev: p.queueRev()}, nil)
		})

	return nil, errReplyDeferred
}

// editQueue edits the queued entries still to play and hands them back to the
// list through SetQueue, as a controller's set_queue does.
func editQueue(list *tracks.List, move bool, uid, before string, span int) error {
	rows := list.UpcomingQueue()
	for _, row := range rows {
		if row.Metadata["is_queued"] != "true" {
			return errQueueUnflagged
		}
	}

	edited, err := editRows(rows, move, uid, before, span)
	if err != nil {
		return err
	}

	list.SetQueue(nil, edited)
	return nil
}

// editRows removes the first row whose uid is uid, or moves it to just before
// the first other row whose uid is before. With before empty it goes after the
// first span-1 others: the end of the span rows a client was shown. rows is
// left as it is.
func editRows(rows []*connectpb.ContextTrack, move bool, uid, before string, span int) ([]*connectpb.ContextTrack, error) {
	from := slices.IndexFunc(rows, func(track *connectpb.ContextTrack) bool { return track.Uid == uid })
	if from < 0 {
		return nil, errQueueRowGone
	}

	row := rows[from]
	rest := slices.Delete(slices.Clone(rows), from, from+1)
	if !move {
		return rest, nil
	}

	to := max(0, min(span-1, len(rest)))
	if before != "" {
		if to = slices.IndexFunc(rest, func(track *connectpb.ContextTrack) bool { return track.Uid == before }); to < 0 {
			return nil, errQueueRowGone
		}
	}

	return slices.Insert(rest, to, row), nil
}
