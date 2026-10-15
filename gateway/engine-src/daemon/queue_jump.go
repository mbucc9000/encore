package daemon

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/devgianlu/go-librespot/tracks"
)

// Encore patch 9: a tap on a row of Up Next plays it (/player/queue/jump).
//
// The row is named by its uid, which names exactly one row, and must still be
// upcoming. There is no rev: the engine runs ahead of a client and changes
// song often, so a rev would refuse good taps. It is not /player/next with a
// track: that matches by uri as well, walks the history from the context's
// start, and injects a song it does not find (List.TrySeekTo), while an older
// engine, which ignores fields it does not know, would only skip one song.
//
// The jump is skipNext's with a track: a load that supersedes whatever load
// or step was out, the list moved on the loader lane (List.JumpAhead: never
// back, never by uri, no page fetched, nothing injected), and one track load.
// The rows above the one tapped become the history, or for a queued row are
// dropped; the window of upcoming rows is walked again from the new position,
// so it refills by itself. Nothing is sent to Spotify of its own: the load,
// the metadata of the rows that enter the window, and the connect state, as
// for any skip.
//
// Nor is a jump to a row of the context or autoplay made while those rows are
// shown in a controller's set_queue order (nextHinted) that is not the list's
// own: the list goes by its own, and would pass over rows shown below the one
// tapped. It is refused once the list's own rows are published, as an edit is.

// logQueueJump logs a jump's outcome, with no uid or uri.
func (p *AppPlayer) logQueueJump(section string, err error) {
	p.app.log.Infof("queue jump %s -> %d", section, queueEditStatus(err))
}

// queueJump answers /player/queue/jump. That the row is upcoming is checked
// here, on the player loop; the jump itself runs as a list job, which
// answers once the new rows are published, before the track has loaded.
func (p *AppPlayer) queueJump(req ApiRequest) (any, error) {
	data := req.Data.(ApiRequestDataQueueJump)

	if p.state.tracks == nil {
		p.logQueueJump("none", ErrNoSession)
		return nil, ErrNoSession
	}

	// The playing row is not among those next: a client that taps it gets
	// the 409, and plays it from its start itself.
	next := p.publishedNext()
	row := findQueueRow(next, data.Uid, "", -1)
	if row < 0 {
		err := &apiError{kind: ErrConflict, err: fmt.Errorf("queue jump refused: the row is not upcoming")}
		p.logQueueJump("none", err)
		return nil, err
	}
	section := next[row].Provider

	// The rows after the queue in a controller's order: unless that is the
	// list's own, the job jumps nowhere, and only publishes the list's own
	// rows to refuse it with (queueEdit's rule).
	hinted := section != queueSectionQueue && p.nextHinted
	var shown []string
	if hinted {
		shown = pastQueue(next)
	}

	// skipNext's with a track, from here on. A session and its events are
	// there whenever a list is (the checks are for the tests' players).
	if p.sess != nil && p.sess.Events() != nil {
		p.sess.Events().OnPlayerSkipForward(p.primaryStream, p.player.PositionMs(), true)
	}
	delay := p.noteSkip()

	// What this load supersedes: a load of the current track that was out,
	// or a step forward waiting for the prefetch it kept (patch 7).
	superseding := p.loadInFlight || p.keptStep

	// Jumping straight to a chosen track: the DJ introduces it with its jump
	// line.
	p.narrationJumped = true
	p.loadGen++

	// Set when the row was gone by the time the job ran, or the rows shown
	// were not the list's. Written on the lane, read by the commit, which runs
	// after the lane has handed its result back.
	var refused error

	reply := apiReply(req)
	p.listJobReply("queue jump", classLoad, nil, reply,
		func(ctx context.Context, list *tracks.List) error {
			if hinted && !listsOwnOrder(ctx, list, shown) {
				refused = errQueueHinted
				return nil
			}

			err := list.JumpAhead(data.Uid)
			if errors.Is(err, tracks.ErrNotAhead) {
				// The list is as it was: answering the walk with no error
				// has listJob take the snapshot to publish.
				refused = err
				return nil
			}
			return err
		},
		func(p *AppPlayer, snap *tracks.Snapshot, err error) {
			if err == nil && refused != nil {
				p.narrationJumped = false
				p.jumpRefused(snap, superseding)
				err = refused
			}

			if err != nil {
				p.narrationJumped = false
				err = queueEditError(err)
				p.logQueueJump(section, err)
				reply.done(nil, err)
				return
			}

			p.publishSnapshot(snap)
			p.state.player.Timestamp = time.Now().UnixMilli()
			p.state.player.PositionAsOfTimestamp = 0

			p.loadCurrentTrack(p.state.player.IsPaused, true, true, delay, func(err error) {
				if err != nil {
					p.app.log.WithError(err).Warn("failed loading current track (queue jump)")
				}
			})

			p.logQueueJump(section, nil)
			reply.done(&ApiQueueRevision{Rev: p.queueRev()}, nil)
		})

	return nil, errReplyDeferred
}

// jumpRefused commits a jump whose row was no longer ahead when its job ran,
// or was shown in a controller's order: the jump changed nothing in the list,
// and is answered 409. But being a load, it superseded what was out before
// it. A step forward's walk ran all the same, before it, while its commit
// never comes; a load that was out never lands. So the list's current entry is published and loaded when it is not
// the one the state played, or a load of it was out (superseding); otherwise,
// as for a refused edit, only the rows around it are published.
func (p *AppPlayer) jumpRefused(snap *tracks.Snapshot, superseding bool) {
	moved := queueRowKey(snap.Current) != queueRowKey(p.state.player.Track)
	if !moved && !superseding {
		p.publishUpcoming(snap)
		p.updateState()
		return
	}

	p.publishSnapshot(snap)
	if moved {
		p.state.player.Timestamp = time.Now().UnixMilli()
		p.state.player.PositionAsOfTimestamp = 0
	}

	p.loadCurrentTrack(p.state.player.IsPaused, true, true, 0, func(err error) {
		if err != nil {
			p.app.log.WithError(err).Warn("failed loading current track (refused queue jump)")
		}
	})
}
