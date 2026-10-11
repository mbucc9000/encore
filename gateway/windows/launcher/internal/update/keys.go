package update

// TrustedKeys are the Ed25519 public keys an Encore release's SHA256SUMS.txt must be signed with (DESIGN-UPDATES.md
// §4.5). Public information: the private key never leaves the release owner's computer. The bridge embeds the same
// list (gateway/src/updatekeys.js); the release tools check that both lists are equal, hold at most 3 keys and never
// the RFC 8032 test keys, and that a release is signed with one of them.
//
//	ID:  the first 16 hex digits of SHA-256 over the raw 32-byte key
//	Key: the raw 32-byte key, standard base64
//
// Rotation (§4.5): a release first embeds the old and the new key, a later one is signed with the new key, and the old
// key leaves the list one release after that. encore-release-1 was added on 2026-10-10.
var TrustedKeys = []Key{
	{ID: "7eec300915b1339f", Key: "HXw5r89+nZZF8BVpaXtDWmHjVGXuNjRndPGnJsnyzRg=", Name: "encore-release-1"},
}
