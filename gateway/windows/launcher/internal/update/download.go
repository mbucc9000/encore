package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// Failure is an Update now step that went wrong: a §5.9 code, plus a content-free detail for the log.
type Failure struct {
	Code   string
	Detail string
}

func (f *Failure) Error() string { return f.Code }

// ErrCancelled: the download was cancelled (Cancel update, the admin page, Quit). The .part is kept for a resume.
var ErrCancelled = errors.New("cancelled")

// Progress reports the bytes done of total (at most once per ProgressGap, and once at the end).
type Progress func(done, total int64)

// DownloadInstaller downloads this version's installer into dir as <name>.part, resuming a .part of the same
// version, asset id and size (st.Download), and renames it to <name> when its size is right (§5.4). It returns the
// file's path, ErrCancelled, or a *Failure (download_failed, no_space). The caller verifies the file and saves st.
func (c *Client) DownloadInstaller(ctx context.Context, dir, ver string, asset Asset, st *State, progress Progress) (string, error) {
	name := InstallerName(ver)
	final := filepath.Join(dir, name)
	part := final + ".part"
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", &Failure{Code: CodeDownloadFailed, Detail: errText(err)}
	}
	same := st.Download != nil && st.Download.Version == ver && st.Download.AssetID == asset.ID && st.Download.Size == asset.Size
	if !same {
		os.Remove(part)
		os.Remove(final)
	}
	st.Download = &DownloadRec{Version: ver, AssetID: asset.ID, Size: asset.Size}
	if fi, err := os.Stat(final); err == nil && same && fi.Size() == asset.Size {
		return final, nil // downloaded before (Setup was cancelled): the caller verifies it again
	}
	os.Remove(final)

	have := int64(0)
	if fi, err := os.Stat(part); err == nil {
		have = fi.Size()
	}
	if have > asset.Size {
		os.Remove(part)
		have = 0
	}
	if c.cfg.FreeSpace != nil {
		if free, err := c.cfg.FreeSpace(dir); err == nil && free < FreeSpaceNeeded(asset.Size-have) {
			c.logf("I", "update: no_space")
			return "", &Failure{Code: CodeNoSpace}
		}
	}
	c.logf("I", "update: downloading %s (%s)", ver, mb(asset.Size))
	if have > 0 {
		c.logf("I", "update: resumed at %s", mb(have))
	}

	pr := &throttle{gap: c.cfg.ProgressGap, now: c.cfg.Now, fn: progress}
	restarted := false
	var last error
	for try := 1; try <= 3; try++ {
		if try > 1 {
			d := c.cfg.RetryDelays[min(try-2, len(c.cfg.RetryDelays)-1)]
			if c.cfg.Sleep(ctx, d) != nil {
				c.logf("I", "update: cancelled")
				return "", ErrCancelled
			}
		}
		last = c.fetchInto(ctx, c.AssetURL(ver, name), part, asset.Size, pr, &restarted)
		if last == nil {
			break
		}
		if ctx.Err() != nil {
			c.logf("I", "update: cancelled")
			return "", ErrCancelled
		}
		c.logf("I", "update: download_failed (try %d of 3)", try)
	}
	if last != nil {
		return "", &Failure{Code: CodeDownloadFailed, Detail: errText(last)}
	}
	fi, err := os.Stat(part)
	if err != nil || fi.Size() != asset.Size {
		os.Remove(part)
		return "", &Failure{Code: CodeDownloadFailed, Detail: "size"}
	}
	pr.done(asset.Size, asset.Size)
	if err := os.Rename(part, final); err != nil {
		return "", &Failure{Code: CodeDownloadFailed, Detail: errText(err)}
	}
	return final, nil
}

var contentRangeRe = regexp.MustCompile(`^bytes ([0-9]+)-([0-9]+)/([0-9]+)$`)

// fetchInto makes one request for the rest of the file: Range from the .part's size; 206 with the matching
// Content-Range appends, 200 starts again from zero, 416 or anything odd starts again from zero once.
func (c *Client) fetchInto(ctx context.Context, u, part string, size int64, pr *throttle, restarted *bool) error {
	for {
		have := int64(0)
		if fi, err := os.Stat(part); err == nil {
			have = fi.Size()
		}
		if have > size {
			os.Remove(part)
			have = 0
		}
		if have == size && size > 0 {
			return nil
		}
		again, err := c.fetchOnce(ctx, u, part, have, size, pr, restarted)
		if !again {
			return err
		}
	}
}

func (c *Client) fetchOnce(ctx context.Context, u, part string, have, size int64, pr *throttle, restarted *bool) (again bool, err error) {
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, written, err := c.request(rctx, u, "")
	if err != nil {
		return false, err
	}
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	c.contacts.Add(1)
	resp, err := c.dlHTTP.Do(req)
	if err != nil {
		return false, fmt.Errorf("%s: %w", classify(err, written.Load()), err)
	}
	defer resp.Body.Close()

	restart := func() (bool, error) {
		if *restarted {
			return false, fmt.Errorf("unexpected answer %d", resp.StatusCode)
		}
		*restarted = true
		os.Remove(part)
		return true, nil
	}
	flags := os.O_WRONLY | os.O_CREATE
	start := int64(0)
	switch resp.StatusCode {
	case http.StatusPartialContent:
		m := contentRangeRe.FindStringSubmatch(resp.Header.Get("Content-Range"))
		if have == 0 || m == nil || m[1] != strconv.FormatInt(have, 10) || m[2] != strconv.FormatInt(size-1, 10) || m[3] != strconv.FormatInt(size, 10) {
			return restart()
		}
		flags |= os.O_APPEND
		start = have
	case http.StatusOK:
		flags |= os.O_TRUNC
	case http.StatusRequestedRangeNotSatisfiable:
		return restart()
	default:
		return false, fmt.Errorf("http %d", resp.StatusCode)
	}
	if resp.ContentLength >= 0 && resp.ContentLength != size-start {
		if resp.StatusCode == http.StatusOK {
			return false, fmt.Errorf("length %d, expected %d", resp.ContentLength, size)
		}
		return restart()
	}
	f, err := os.OpenFile(part, flags, 0o600)
	if err != nil {
		return false, err
	}
	// stalled: no byte for StallTimeout ends the request
	stall := time.AfterFunc(c.cfg.StallTimeout, cancel)
	defer stall.Stop()
	done := start
	buf := make([]byte, 64<<10)
	var werr error
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			stall.Reset(c.cfg.StallTimeout)
			if done+int64(n) > size {
				werr = errors.New("longer than expected")
				break
			}
			if _, err := f.Write(buf[:n]); err != nil {
				werr = err
				break
			}
			done += int64(n)
			pr.report(done, size)
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			if ctx.Err() == nil && rctx.Err() != nil {
				werr = errors.New("stalled")
			} else {
				werr = rerr
			}
			break
		}
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil && done != size {
		werr = errors.New("short")
	}
	return false, werr
}

// throttle passes progress on at most once per gap.
type throttle struct {
	gap  time.Duration
	now  func() time.Time
	fn   Progress
	mu   sync.Mutex
	last time.Time
}

func (t *throttle) report(done, total int64) {
	if t.fn == nil {
		return
	}
	t.mu.Lock()
	now := t.now()
	if !t.last.IsZero() && now.Sub(t.last) < t.gap {
		t.mu.Unlock()
		return
	}
	t.last = now
	t.mu.Unlock()
	t.fn(done, total)
}

func (t *throttle) done(done, total int64) {
	if t.fn != nil {
		t.fn(done, total)
	}
}

func mb(n int64) string { return fmt.Sprintf("%.1f MB", float64(n)/(1<<20)) }
