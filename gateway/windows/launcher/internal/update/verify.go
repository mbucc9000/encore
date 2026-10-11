package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
)

// Key is one public release-signing key of the trust list (§4.5): Key is the base64 of the raw 32-byte Ed25519
// public key, ID the first 16 hex digits of its SHA-256.
type Key struct {
	ID   string
	Key  string
	Name string
}

// Public decodes the key.
func (k Key) Public() (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(k.Key)
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("not a base64 Ed25519 public key")
	}
	return ed25519.PublicKey(b), nil
}

// KeyID is the first 16 hex digits of the SHA-256 of the raw public key.
func KeyID(pub []byte) string {
	h := sha256.Sum256(pub)
	return hex.EncodeToString(h[:8])
}

// VerifySums checks the raw 64-byte Ed25519 signature over the exact bytes of SHA256SUMS.txt against every key of the
// list (PureEdDSA, no prehash, no context). It returns the id of the key that matched, or ok=false and the ids tried.
func VerifySums(sums, sig []byte, keys []Key) (matched string, tried []string, ok bool) {
	for _, k := range keys {
		pub, err := k.Public()
		if err != nil {
			continue
		}
		id := KeyID(pub)
		tried = append(tried, id)
		if len(sig) == ed25519.SignatureSize && ed25519.Verify(pub, sums, sig) {
			return id, tried, true
		}
	}
	return "", tried, false
}

// ErrHashMismatch: the downloaded file isn't the one the signed checksum list names.
var ErrHashMismatch = errors.New("the file doesn't match the signed checksum")

// VerifyFile hashes an open file from its start (the launcher passes a handle that no other process can write to,
// rename or delete while it is open, §5.5) and compares its size and SHA-256.
func VerifyFile(f *os.File, wantSHA string, wantSize int64) error {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return err
	}
	if n != wantSize {
		return fmt.Errorf("%w (size %d, expected %d)", ErrHashMismatch, n, wantSize)
	}
	if hex.EncodeToString(h.Sum(nil)) != wantSHA {
		return ErrHashMismatch
	}
	return nil
}

// OpenVerified opens path with open (the launcher's share-locked open), checks its size and SHA-256 through that
// handle and returns it still open. On a mismatch the file is closed and deleted: it is never run (§4.3, §5.5).
func OpenVerified(path string, open func(string) (*os.File, error), wantSHA string, wantSize int64) (*os.File, error) {
	f, err := open(path)
	if err != nil {
		return nil, err
	}
	if err := VerifyFile(f, wantSHA, wantSize); err != nil {
		f.Close()
		os.Remove(path)
		os.Remove(path + ".part")
		if errors.Is(err, ErrHashMismatch) {
			return nil, ErrHashMismatch
		}
		return nil, err
	}
	return f, nil
}
