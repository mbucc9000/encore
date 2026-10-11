package core

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Redactor replaces the Windows user-profile folder in log lines with %USERPROFILE%, so a log someone attaches to a
// support request doesn't carry their Windows account name. It matches the path case-insensitively, with \, / or
// JSON-escaped \\ separators, and only when the path ends there (C:\Users\Jo never eats the start of C:\Users\Josh).
type Redactor struct{ re *regexp.Regexp }

// NewRedactor builds a Redactor for a profile folder such as C:\Users\Name. An empty or very short path gives a
// Redactor that changes nothing.
func NewRedactor(profileDir string) *Redactor {
	p := strings.TrimRight(profileDir, `\/`)
	if len(p) < 4 {
		return &Redactor{}
	}
	parts := strings.FieldsFunc(p, func(r rune) bool { return r == '\\' || r == '/' })
	var quoted []string
	for _, x := range parts {
		quoted = append(quoted, regexp.QuoteMeta(x))
	}
	sep := `(?:\\\\|\\|/)`
	pat := `(?i)` + strings.Join(quoted, sep) + `([\\/"'\s;,.:)\]}>|]|$)`
	return &Redactor{re: regexp.MustCompile(pat)}
}

// Line returns s with the profile folder replaced.
func (r *Redactor) Line(s string) string {
	if r == nil || r.re == nil {
		return s
	}
	return r.re.ReplaceAllString(s, `%USERPROFILE%${1}`)
}

// RotatingLog is the launcher's log file (logs\bridge.log): the bridge's stdout/stderr lines plus the launcher's own,
// rotated at MaxBytes into bridge.log.1 … bridge.log.<Keep>. A date line is written at the start and whenever the
// day changes, because the bridge's own lines carry only the time of day. Safe for concurrent use.
type RotatingLog struct {
	Path     string
	MaxBytes int64
	Keep     int
	Redact   *Redactor
	Now      func() time.Time

	mu   sync.Mutex
	f    *os.File
	size int64
	day  string
}

// OpenLog opens (appends to) path, creating its folder.
func OpenLog(path string, maxBytes int64, keep int, redact *Redactor) (*RotatingLog, error) {
	l := &RotatingLog{Path: path, MaxBytes: maxBytes, Keep: keep, Redact: redact, Now: time.Now}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *RotatingLog) open() error {
	f, err := os.OpenFile(l.Path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f, l.size = f, st.Size()
	return nil
}

// rotate shifts bridge.log.N-1 → .N … bridge.log → .1 and starts a new file. If Windows refuses a rename (someone
// has the file open without delete sharing), the current file is kept and simply grows; nothing is lost.
func (l *RotatingLog) rotate() {
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
	for i := l.Keep; i >= 1; i-- {
		src := l.Path
		if i > 1 {
			src = fmt.Sprintf("%s.%d", l.Path, i-1)
		}
		dst := fmt.Sprintf("%s.%d", l.Path, i)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		os.Remove(dst)
		os.Rename(src, dst)
	}
	if err := l.open(); err != nil {
		l.f = nil
	}
	l.day = ""
}

func (l *RotatingLog) writeLocked(line string) {
	if l.f == nil {
		if err := l.open(); err != nil {
			return
		}
	}
	now := l.Now()
	if d := now.Format("2006-01-02"); d != l.day {
		l.day = d
		l.raw(fmt.Sprintf("---- %s (UTC%s) ----", d, now.Format("-07:00")))
	}
	l.raw(line)
	if l.MaxBytes > 0 && l.size >= l.MaxBytes {
		l.rotate()
	}
}

func (l *RotatingLog) raw(line string) {
	if l.f == nil {
		return
	}
	n, _ := l.f.WriteString(line + "\r\n")
	l.size += int64(n)
}

// Line writes one line from the bridge as it is (after redaction).
func (l *RotatingLog) Line(s string) {
	s = strings.TrimRight(s, "\r\n")
	if l.Redact != nil {
		s = l.Redact.Line(s)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.writeLocked(s)
}

// Launcher writes one of the launcher's own lines in the bridge's format: "HH:MM:SS.mmm I [launcher] message".
// level is "I", "W" or "E".
func (l *RotatingLog) Launcher(level, format string, a ...any) {
	msg := fmt.Sprintf(format, a...)
	if l.Redact != nil {
		msg = l.Redact.Line(msg)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.writeLocked(fmt.Sprintf("%s %s [launcher] %s", l.Now().Format("15:04:05.000"), level, msg))
}

// Close closes the file.
func (l *RotatingLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

// PumpLines reads r until EOF and hands every line to fn. Lines longer than maxLine bytes are cut into pieces, so a
// runaway line can never block the pipe or use unbounded memory.
func PumpLines(r io.Reader, maxLine int, fn func(string)) error {
	br := bufio.NewReaderSize(r, 4096)
	var buf []byte
	flush := func() {
		if len(buf) > 0 {
			fn(strings.TrimRight(string(buf), "\r\n"))
		}
		buf = buf[:0]
	}
	for {
		chunk, err := br.ReadSlice('\n')
		buf = append(buf, chunk...)
		for len(buf) > maxLine { // a runaway line: hand it over in pieces
			fn(string(buf[:maxLine]))
			buf = append(buf[:0], buf[maxLine:]...)
		}
		switch {
		case err == nil:
			flush()
		case errors.Is(err, bufio.ErrBufferFull):
			// the same line continues
		case errors.Is(err, io.EOF):
			flush()
			return nil
		default:
			flush()
			return err
		}
	}
}
