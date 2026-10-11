// Command fakegh serves a release folder as a fake GitHub release of mbucc9000/encore on a loopback address, for the
// launcher's Wine update smoke test (testdata/update-smoke.sh). Test tool only: never part of a bundle.
//
//	fakegh -dir <folder> -ver 1.1.1 [-addr 127.0.0.1:18765] [-sign test1|test2|none] [-tamper <file>] [-log <file>]
//
// Every file in the folder becomes an asset. SHA256SUMS.txt is made from them and signed with the RFC 8032 TEST 1
// key (test2: the TEST 2 key, which the test launcher doesn't trust). -tamper changes one byte of a file after
// signing. Each request is logged as "<method> <path> query=<0|1> ua=<User-Agent> headers=<names>".
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"encore-bridge/launcher/internal/update/fakegh"
)

func main() {
	dir := flag.String("dir", "", "release folder")
	ver := flag.String("ver", "", "release version (tag v<ver>)")
	addr := flag.String("addr", "127.0.0.1:18765", "loopback address to listen on")
	sign := flag.String("sign", "test1", "test1, test2 or none")
	tamper := flag.String("tamper", "", "change one byte of this file after signing")
	logFile := flag.String("log", "", "request log (default: stderr)")
	flag.Parse()
	if *dir == "" || *ver == "" {
		log.Fatal("fakegh: -dir and -ver are required")
	}
	host, _, err := net.SplitHostPort(*addr)
	if err != nil || (host != "127.0.0.1" && host != "::1" && host != "localhost") {
		log.Fatal("fakegh: -addr must be a loopback address")
	}
	files := map[string][]byte{}
	entries, err := os.ReadDir(*dir)
	if err != nil {
		log.Fatal(err)
	}
	for _, e := range entries {
		if e.IsDir() || e.Name() == "SHA256SUMS.txt" || e.Name() == "SHA256SUMS.txt.sig" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(*dir, e.Name()))
		if err != nil {
			log.Fatal(err)
		}
		files[e.Name()] = b
	}
	var seed []byte
	switch *sign {
	case "test1":
		seed = fakegh.Test1Seed
	case "test2":
		seed = fakegh.Test2Seed
	case "none":
	default:
		log.Fatal("fakegh: -sign must be test1, test2 or none")
	}
	rel := fakegh.MakeRelease(*ver, files, seed)
	if *tamper != "" {
		b, ok := rel.Files[*tamper]
		if !ok || len(b) == 0 {
			log.Fatalf("fakegh: no file %s to tamper with", *tamper)
		}
		c := append([]byte(nil), b...)
		c[len(c)/2] ^= 0xff
		rel.Files[*tamper] = c
	}
	out := os.Stderr
	if *logFile != "" {
		f, err := os.OpenFile(*logFile, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
		if err != nil {
			log.Fatal(err)
		}
		out = f
	}
	fake := fakegh.New(rel, fakegh.Options{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var names []string
		for k := range r.Header {
			names = append(names, strings.ToLower(k))
		}
		sort.Strings(names)
		q := 0
		if r.URL.RawQuery != "" {
			q = 1
		}
		fmt.Fprintf(out, "%s %s query=%d ua=%s headers=%s\n", r.Method, r.URL.Path, q, r.Header.Get("User-Agent"), strings.Join(names, ","))
		fake.ServeHTTP(w, r)
	})
	l, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Fprintf(os.Stderr, "fakegh: serving %s v%s on http://%s (%d files, sign %s)\n", *dir, *ver, *addr, len(files), *sign)
	log.Fatal(http.Serve(l, h))
}
