package update

import (
	"context"
	"strings"
	"time"
)

// Report says what a check did.
type Report struct {
	Dev       bool // a development build: no request was made
	Reused    bool // throttled (§2.3): the stored result was answered without a request
	Contacted bool // a request may have reached GitHub
}

// Check asks GitHub for the latest release and updates st (§2). manual: the user asked (Check for updates, Check now),
// which is throttled instead of scheduled. The caller saves st.
func (c *Client) Check(ctx context.Context, st *State, manual bool) Report {
	if c.dev {
		return Report{Dev: true}
	}
	now := c.cfg.Now()
	st.FixClock(now)
	if st.Error != nil && st.Error.Code == CodeRateLimited && st.Error.RetryAt != nil && now.Before(*st.Error.RetryAt) {
		return Report{Reused: true} // GitHub asked to wait: no request before retry_at
	}
	if manual && st.LastContact != nil && now.Sub(*st.LastContact) < ManualThrottle {
		return Report{Reused: true}
	}

	etag := ""
	if st.ETag != "" && st.ETagFor == c.etagFor() && st.Result != nil {
		etag = st.ETag
	}
	a := c.fetchLatest(ctx, etag)
	rep := Report{Contacted: a.contacted}
	if a.contacted {
		t := now
		st.LastContact = &t
	}
	if a.err != nil {
		st.Error = a.err
		c.logFailure(a.err)
		c.schedule(st, now)
		return rep
	}
	switch a.status {
	case 304:
		st.Error = nil
		c.logf("I", "update check: not changed since the last check")
	case 404:
		st.Error = nil
		st.Result = &Result{State: ResultNoRelease}
		st.Verified = nil
		st.ETag, st.ETagFor = "", ""
		c.logf("I", "update check: no release published yet")
	default:
		st.Error = nil
		if e := c.evaluate(ctx, a, st); e != nil {
			st.Error = e
			c.logFailure(e)
			st.ETag, st.ETagFor = "", "" // the answer wasn't fully used: the next check asks again in full
		} else {
			st.ETag, st.ETagFor = a.etag, c.etagFor()
			if a.etag == "" {
				st.ETagFor = ""
			}
		}
	}
	if st.Error == nil {
		t := now
		st.CheckedAt = &t
	}
	c.schedule(st, now)
	return rep
}

func (c *Client) etagFor() string { return c.cfg.Current + " " + c.cfg.Kind }

// trusts: id is the key id of a key in this client's trust list.
func (c *Client) trusts(id string) bool {
	for _, k := range c.keys {
		if pub, err := k.Public(); err == nil && KeyID(pub) == id {
			return true
		}
	}
	return false
}

// DropUntrusted forgets a stored verification made with a key that isn't in this client's trust list (any more: a
// key removed in a later release, §4.5), so the release it verified isn't offered until it is verified again; the
// stored ETag goes too, so the next check asks GitHub in full. It reports whether st changed (to be saved).
func (c *Client) DropUntrusted(st *State) bool {
	if st.Verified == nil || c.trusts(st.Verified.KeyID) {
		return false
	}
	st.Verified = nil
	st.ETag, st.ETagFor = "", ""
	return true
}

func (c *Client) schedule(st *State, now time.Time) {
	t := next(now, st.Error, c.cfg.Jitter())
	st.NextCheck = &t
}

func (c *Client) logFailure(e *CheckError) {
	switch e.Code {
	case CodeRateLimited:
		until := "later"
		if e.RetryAt != nil {
			until = e.RetryAt.UTC().Format("15:04Z")
		}
		c.logf("W", "update check failed: rate_limited until %s", until)
	case CodeHTTPError:
		c.logf("W", "update check failed: http_error %d", e.HTTPStatus)
	case CodeIncomplete:
		c.logf("W", "update check failed: incomplete_release %s", e.Version)
	default:
		c.logf("W", "update check failed: %s", e.Code)
	}
}

// evaluate reads a 200 answer (§2.5): a final, newer release with this kind's assets is verified before it is
// announced. It returns a transport error that stopped the verification (the result is then left as it was).
func (c *Client) evaluate(ctx context.Context, a answer, st *State) *CheckError {
	r := a.rel
	v, ok := ParseTag(*r.TagName)
	if !ok || r.Draft || r.Prerelease {
		c.logf("I", "update check: latest release tag isn't a final version: ignored")
		st.Result, st.Verified = &Result{State: ResultUpToDate}, nil
		return nil
	}
	ver := v.String()
	published := ""
	if r.PublishedAt != nil {
		if t, err := time.Parse(time.RFC3339, *r.PublishedAt); err == nil {
			published = t.UTC().Format(time.RFC3339)
		}
	}
	if !Newer(v, c.cur) {
		c.logf("I", "update check: up to date (%s)", c.cfg.Current)
		st.Result, st.Verified = &Result{State: ResultUpToDate, Version: ver, PublishedAt: published}, nil
		return nil
	}

	need := KindAsset(c.cfg.Kind, ver)
	assets := map[string]Asset{}
	for _, x := range r.Assets {
		if x.State != "uploaded" {
			continue
		}
		switch x.Name {
		case SumsName, SigName, need:
			if _, dup := assets[x.Name]; !dup {
				assets[x.Name] = Asset{ID: x.ID, Size: x.Size}
			}
		}
	}
	sums, okS := assets[SumsName]
	sig, okG := assets[SigName]
	kind, okK := assets[need]
	if !okS || !okG || !okK || sums.Size < 1 || sums.Size > maxSumsSize || sig.Size != sigSize ||
		kind.Size < 1 || kind.Size > maxInstallerSize {
		st.Result = &Result{State: ResultIncomplete, Version: ver, PublishedAt: published}
		st.Verified = nil
		c.logf("W", "update check failed: incomplete_release %s", ver)
		return nil
	}
	res := &Result{State: ResultAvailable, Version: ver, PublishedAt: published, Assets: assets}

	// the two small files are fetched once per release: reuse a verification of the same files, made with a key this
	// launcher still trusts (a key removed from the list, §4.5, never keeps a release offered)
	if p := st.Result; p != nil && p.State == ResultAvailable && p.Version == ver && st.Verified != nil &&
		st.Verified.Version == ver && st.Verified.SHA256[need] != "" && c.trusts(st.Verified.KeyID) &&
		p.Assets[SumsName] == sums && p.Assets[SigName] == sig && p.Assets[need] == kind {
		st.Result = res
		return nil
	}

	vr := c.VerifyRelease(ctx, ver, need)
	switch {
	case vr.Err != nil:
		return vr.Err
	case vr.Code != "":
		st.Result = &Result{State: vr.Code, Version: ver, PublishedAt: published}
		st.Verified = nil
		return nil
	}
	st.Result = res
	st.Verified = &Verified{Version: ver, KeyID: vr.KeyID, SHA256: map[string]string{need: vr.SHA256}}
	c.logf("I", "update check: %s available (signature ok, key %s)", ver, vr.KeyID)
	return nil
}

// Verification is the outcome of §4.3 steps 1-4 for one release and asset.
type Verification struct {
	Sums, Sig []byte
	KeyID     string
	SHA256    string      // the asset's signed hash
	Code      string      // bad_signature or sums_entry_missing ("" when verified)
	Err       *CheckError // the files couldn't be fetched
}

// VerifyRelease downloads SHA256SUMS.txt and its signature, checks the signature against the trust list, parses the
// list strictly and finds exactly one entry for name (§4.3 steps 1-4).
func (c *Client) VerifyRelease(ctx context.Context, ver, name string) Verification {
	sums, e := c.getSmall(ctx, ver, SumsName, maxSumsSize)
	if e != nil {
		return Verification{Err: e}
	}
	sig, e := c.getSmall(ctx, ver, SigName, maxSigRead)
	if e != nil {
		return Verification{Err: e}
	}
	vr := Verification{Sums: sums, Sig: sig}
	id, tried, ok := VerifySums(sums, sig, c.keys)
	if !ok {
		vr.Code = CodeBadSignature
		c.logf("W", "update check: %s not offered: bad_signature (keys tried: %s)", ver, strings.Join(tried, ", "))
		return vr
	}
	vr.KeyID = id
	list, err := ParseSums(sums)
	h, found := list[name]
	if err != nil || !found {
		vr.Code = CodeSumsEntryMissing
		c.logf("W", "update check: %s not offered: sums_entry_missing", ver)
		return vr
	}
	vr.SHA256 = h
	return vr
}
