package update

import (
	"errors"
	"regexp"
	"strings"
)

// The release's checksum list and its signature (§4.1).
const (
	SumsName = "SHA256SUMS.txt"
	SigName  = "SHA256SUMS.txt.sig"

	maxSumsSize = 64 << 10 // SHA256SUMS.txt
	sigSize     = 64       // SHA256SUMS.txt.sig: the raw Ed25519 signature
	maxSigRead  = 1 << 10
)

var sumsLineRe = regexp.MustCompile(`^[0-9a-f]{64}  [A-Za-z0-9._+-]{1,128}$`)

var (
	errSumsEmpty = errors.New("empty signed file list")
	errSumsBOM   = errors.New("signed file list starts with a BOM")
	errSumsLine  = errors.New("signed file list has a malformed line")
	errSumsName  = errors.New("signed file list has a file name with ..")
	errSumsDup   = errors.New("signed file list names a file twice")
)

// ParseSums reads SHA256SUMS.txt strictly (§4.3 step 3): UTF-8 without a BOM, LF line ends, every line
// "<64 lower-case hex>  <name>" with a plain file name (no /, \ or ..), no empty lines except the final newline (which
// may be missing), no name twice. It returns name → hash.
func ParseSums(b []byte) (map[string]string, error) {
	if len(b) == 0 {
		return nil, errSumsEmpty
	}
	if len(b) >= 3 && b[0] == 0xef && b[1] == 0xbb && b[2] == 0xbf {
		return nil, errSumsBOM
	}
	s := strings.TrimSuffix(string(b), "\n")
	out := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		if !sumsLineRe.MatchString(line) {
			return nil, errSumsLine
		}
		hash, name := line[:64], line[66:]
		if strings.Contains(name, "..") {
			return nil, errSumsName
		}
		if _, dup := out[name]; dup {
			return nil, errSumsDup
		}
		out[name] = hash
	}
	return out, nil
}
