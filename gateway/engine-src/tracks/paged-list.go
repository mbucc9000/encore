package tracks

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"slices"

	librespot "github.com/devgianlu/go-librespot"
	"golang.org/x/exp/rand"
)

type pagedListItem[T any] struct {
	item    T
	pageIdx int
	itemIdx int
}

type pagedListInterator[T any] struct {
	list *pagedList[T]
	pos  int
	err  error
}

func (i *pagedListInterator[T]) prev() bool {
	if i.pos < 0 {
		panic(fmt.Sprintf("invalid paged list iterator position: %d", i.pos))
	}

	if i.pos == 0 {
		i.err = nil
		return false
	}

	i.pos--
	i.err = nil
	return true
}

func (i *pagedListInterator[T]) next(ctx context.Context) bool {
	for i.pos+1 >= len(i.list.list) {
		if pageIdx, err := i.list.fetchNextPage(ctx); errors.Is(err, io.EOF) {
			i.err = nil
			return false
		} else if err != nil {
			i.err = fmt.Errorf("failed moving to next index %d (page %d): %w", i.pos+1, pageIdx, err)
			return false
		}
	}

	i.pos++
	i.err = nil
	return true
}

func (i *pagedListInterator[T]) error() error {
	return i.err
}

func (i *pagedListInterator[T]) get() pagedListItem[T] {
	if i.pos < 0 {
		panic(fmt.Sprintf("invalid paged list iterator position: %d", i.pos))
	}

	return i.list.list[i.pos]
}

type pagedList[T any] struct {
	log librespot.Logger

	pages librespot.PageResolver[T]
	list  []pagedListItem[T]
	pos   int

	// lastPage is the index of the last page fetched, -1 before the first.
	// The next fetch asks for the page after it. The last entry's own page
	// cannot say which that is once entries ahead have been removed or moved
	// (removeAt, moveTo), nor after a shuffle.
	lastPage int
}

func newPagedList[T any](log librespot.Logger, pages librespot.PageResolver[T]) *pagedList[T] {
	return &pagedList[T]{log: log, pages: pages, list: nil, pos: -1, lastPage: -1}
}

func (l *pagedList[T]) iterHere() *pagedListInterator[T] {
	if l.pos < 0 {
		panic(fmt.Sprintf("invalid paged list position: %d", l.pos))
	}

	return &pagedListInterator[T]{list: l, pos: l.pos, err: nil}
}

func (l *pagedList[T]) iterStart() *pagedListInterator[T] {
	return &pagedListInterator[T]{list: l, pos: -1, err: nil}
}

func (l *pagedList[T]) moveStart(ctx context.Context) error {
	if len(l.list) == 0 {
		if pageIdx, err := l.fetchNextPage(ctx); errors.Is(err, io.EOF) {
			return fmt.Errorf("failed moving to start: no more pages as of %d", pageIdx)
		} else if err != nil {
			return fmt.Errorf("failed moving to start: %w", err)
		}
	}

	l.pos = 0
	return nil
}

// moveInjected puts item at the head of the loaded list and positions the list
// on it. The item belongs to no page, so it is marked with a negative page
// index, which lets callers tell it apart from a real context entry;
// fetchNextPage still asks for the page after the last one fetched, page 0
// when nothing has been loaded yet.
func (l *pagedList[T]) moveInjected(item T) {
	l.list = append([]pagedListItem[T]{{item, -1, -1}}, l.list...)
	l.pos = 0
}

func (l *pagedList[T]) move(iter *pagedListInterator[T]) {
	if iter.err != nil {
		panic("cannot move to errored paged list iterator")
	}

	l.pos = iter.pos
	return
}

func (l *pagedList[T]) get() pagedListItem[T] {
	if l.pos < 0 {
		panic(fmt.Sprintf("invalid paged list position: %d", l.pos))
	}

	return l.list[l.pos]
}

func (l *pagedList[T]) swap(i, j int) {
	if i < 0 || i >= len(l.list) || j < 0 || j >= len(l.list) {
		panic(fmt.Sprintf("invalid swap indices (i: %d, j: %d, len: %d)", i, j, len(l.list)))
	}

	l.list[i], l.list[j] = l.list[j], l.list[i]
	if i == l.pos {
		l.pos = j
	} else if j == l.pos {
		l.pos = i
	}
}

func (l *pagedList[T]) shuffle(rnd *rand.Rand) {
	if len(l.list) <= 1 {
		return
	}

	idx := l.pos
	for i := len(l.list) - 1; i > 0; i-- {
		j := rnd.Intn(i + 1)
		l.list[i], l.list[j] = l.list[j], l.list[i]
		if i == idx {
			idx = j
		} else if j == idx {
			idx = i
		}
	}
	l.pos = idx
}

func (l *pagedList[T]) unshuffle(rnd *rand.Rand) {
	if len(l.list) <= 1 {
		return
	}

	exchanges := make([]int, len(l.list)-1)
	for i := 0; i < len(l.list)-1; i++ {
		exchanges[i] = rnd.Intn(len(l.list) - i)
	}

	idx := l.pos
	for i := 1; i < len(l.list); i++ {
		j := exchanges[len(l.list)-i-1]
		l.list[i], l.list[j] = l.list[j], l.list[i]
		if i == idx {
			idx = j
		} else if j == idx {
			idx = i
		}
	}
	l.pos = idx
}

func (l *pagedList[T]) fetchNextPage(ctx context.Context) (int, error) {
	pageIdx := l.lastPage + 1

	items, err := l.pages.Page(ctx, pageIdx)
	if err != nil {
		return pageIdx, err
	} else if len(items) == 0 {
		return pageIdx, fmt.Errorf("loaded an empty page for %d", pageIdx)
	}

	for trackIdx, item := range items {
		l.list = append(l.list, pagedListItem[T]{item, pageIdx, trackIdx})
	}
	l.lastPage = pageIdx

	l.log.Tracef("fetched new page %d with %d items (list: %d)", pageIdx, len(items), len(l.list))
	return pageIdx, nil
}

func (l *pagedList[T]) clear() {
	l.list = nil
	l.pos = -1
	l.lastPage = -1
}

// removeAt takes the entry at i out of the list. Only an entry ahead of the
// position can go: the one there and those before it have been played.
func (l *pagedList[T]) removeAt(i int) {
	if i <= l.pos || i >= len(l.list) {
		panic(fmt.Sprintf("invalid remove index (i: %d, pos: %d, len: %d)", i, l.pos, len(l.list)))
	}

	l.list = slices.Delete(l.list, i, i+1)
}

// moveTo moves the entry at i to just before the one at j, or to the end for
// j equal to the length. Both are ahead of the position, which stays where it
// is. Each entry keeps the page and index it was loaded with.
func (l *pagedList[T]) moveTo(i, j int) {
	if i <= l.pos || i >= len(l.list) || j <= l.pos || j > len(l.list) {
		panic(fmt.Sprintf("invalid move indices (i: %d, j: %d, pos: %d, len: %d)", i, j, l.pos, len(l.list)))
	}

	item := l.list[i]
	switch {
	case j > i+1:
		copy(l.list[i:j-1], l.list[i+1:j])
		l.list[j-1] = item
	case j < i:
		copy(l.list[j+1:i+1], l.list[j:i])
		l.list[j] = item
	}
}

// moveAhead puts the position on the entry at i, ahead of it: what lies
// between is skipped, and becomes what was played before it. Encore patch 9.
func (l *pagedList[T]) moveAhead(i int) {
	if i <= l.pos || i >= len(l.list) {
		panic(fmt.Sprintf("invalid move ahead index (i: %d, pos: %d, len: %d)", i, l.pos, len(l.list)))
	}

	l.pos = i
}

// sortByOrigin puts the entries back in the order the context gave them: by
// page, then by index within the page, an injected entry (page -1) first, as
// it was. The position stays on the entry it was on. Nothing is fetched, and
// the next fetch is still the page after the last one fetched. Encore patch 9:
// unshuffling a list edited while shuffled, which a replay of the shuffle's
// exchanges cannot do, as they are by position.
func (l *pagedList[T]) sortByOrigin() {
	order := make([]int, len(l.list))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int {
		x, y := l.list[a], l.list[b]
		if c := cmp.Compare(x.pageIdx, y.pageIdx); c != 0 {
			return c
		}
		return cmp.Compare(x.itemIdx, y.itemIdx)
	})

	sorted := make([]pagedListItem[T], len(order))
	pos := l.pos
	for k, i := range order {
		sorted[k] = l.list[i]
		if i == l.pos {
			pos = k
		}
	}
	l.list, l.pos = sorted, pos
}

func (l *pagedList[T]) len() int {
	return len(l.list)
}

// resident returns the items already loaded, oldest first, without fetching.
func (l *pagedList[T]) resident() []T {
	out := make([]T, 0, len(l.list))
	for _, item := range l.list {
		out = append(out, item.item)
	}
	return out
}
