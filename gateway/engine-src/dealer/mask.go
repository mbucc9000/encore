package dealer

import "regexp"

// idRun is a run of the characters ids are made of: a session id, a join
// token, a connection id, a base62 or hex gid, a uuid. Join tokens and uuids
// carry '-' and '_', so those are part of the run rather than breaking it.
var idRun = regexp.MustCompile(`[0-9A-Za-z_-]{12,}`)

// idLike tells an id from words joined by '-' or '_', such as social-connect
// or session_update: a digit or a capital in it, or 12 letters or digits in a
// row.
var idLike = regexp.MustCompile(`[0-9A-Z]|[0-9A-Za-z]{12}`)

// MaskIds replaces every run of 12 or more id characters that looks like an id
// in s with "*", so a message uri can be logged without the ids in it. Every
// run of 12 or more hex or base62 characters is one. A long plain word, or one
// with a digit, is masked too, which costs the log a little and leaks nothing.
func MaskIds(s string) string {
	return idRun.ReplaceAllStringFunc(s, func(run string) string {
		if idLike.MatchString(run) {
			return "*"
		}
		return run
	})
}
