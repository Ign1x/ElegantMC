package mc

import (
	"archive/zip"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type javaSelector struct {
	candidates []string

	mu     sync.Mutex
	cached map[string]javaProbeResult // javaPath -> probe result
}

type javaProbeResult struct {
	major int
	err   string
}

func newJavaSelector(candidates []string) *javaSelector {
	var cleaned []string
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		cleaned = append(cleaned, c)
	}
	if len(cleaned) == 0 {
		cleaned = []string{"java"}
	}
	return &javaSelector{
		candidates: cleaned,
		cached:     make(map[string]javaProbeResult, len(cleaned)),
	}
}

func (s *javaSelector) Select(ctx context.Context, requiredMajor int) (string, int, error) {
	if requiredMajor <= 0 {
		requiredMajor = 8
	}

	type cand struct {
		path  string
		major int
		err   error
	}

	var probed []cand
	for _, c := range s.candidates {
		maj, err := s.probe(ctx, c)
		probed = append(probed, cand{path: c, major: maj, err: err})
	}

	// Choose the smallest major version that satisfies the requirement (more compatible than picking the newest).
	bestPath := ""
	bestMajor := 0
	for _, p := range probed {
		if p.err != nil || p.major <= 0 {
			continue
		}
		if p.major < requiredMajor {
			continue
		}
		if bestPath == "" || p.major < bestMajor {
			bestPath = p.path
			bestMajor = p.major
		}
	}
	if bestPath != "" {
		return bestPath, bestMajor, nil
	}

	var msg strings.Builder
	msg.WriteString(fmt.Sprintf("no java runtime >= %d found. candidates:", requiredMajor))
	for _, p := range probed {
		if p.err != nil {
			msg.WriteString(fmt.Sprintf(" %s(err=%s);", p.path, p.err.Error()))
			continue
		}
		if p.major > 0 {
			msg.WriteString(fmt.Sprintf(" %s(major=%d);", p.path, p.major))
			continue
		}
		msg.WriteString(fmt.Sprintf(" %s(unknown);", p.path))
	}
	msg.WriteString(" set ELEGANTMC_JAVA_CANDIDATES or pass java_path to mc_start")
	return "", 0, errors.New(msg.String())
}

func (s *javaSelector) probe(ctx context.Context, javaPath string) (int, error) {
	s.mu.Lock()
	res, ok := s.cached[javaPath]
	s.mu.Unlock()
	if ok {
		if res.err != "" {
			return 0, errors.New(res.err)
		}
		return res.major, nil
	}

	maj, err := probeJavaMajor(ctx, javaPath)
	s.mu.Lock()
	if err != nil {
		s.cached[javaPath] = javaProbeResult{major: 0, err: err.Error()}
	} else {
		s.cached[javaPath] = javaProbeResult{major: maj}
	}
	s.mu.Unlock()
	return maj, err
}

var reJavaVersion = regexp.MustCompile(`(?m)version "([^"]+)"`)

func probeJavaMajor(ctx context.Context, javaPath string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, javaPath, "-version")
	out, err := cmd.CombinedOutput()
	if err != nil {
		// still try parse: some wrappers return non-zero but print version
	}
	text := string(out)
	m := reJavaVersion.FindStringSubmatch(text)
	if len(m) < 2 {
		return 0, fmt.Errorf("cannot parse java -version output: %s", strings.TrimSpace(firstLine(text)))
	}
	ver := strings.TrimSpace(m[1])
	major, ok := parseJavaMajor(ver)
	if !ok || major <= 0 {
		return 0, fmt.Errorf("unsupported java version string: %q", ver)
	}
	return major, nil
}

func parseJavaMajor(ver string) (int, bool) {
	ver = strings.TrimSpace(ver)
	if ver == "" {
		return 0, false
	}
	ver = strings.TrimPrefix(ver, "jdk-")

	// Legacy: 1.8.0_362
	if strings.HasPrefix(ver, "1.") {
		parts := strings.Split(ver, ".")
		if len(parts) >= 2 {
			n, err := strconv.Atoi(parts[1])
			return n, err == nil
		}
		return 0, false
	}

	// Modern: 17.0.9, 21, 21-ea, 21.0.1+12
	first := ver
	if i := strings.IndexAny(first, ".+-"); i >= 0 {
		first = first[:i]
	}
	n, err := strconv.Atoi(first)
	if err != nil {
		return 0, false
	}
	return n, true
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func requiredJavaMajorFromJar(jarPath string) (int, error) {
	zr, err := zip.OpenReader(jarPath)
	if err != nil {
		return 0, err
	}
	defer zr.Close()

	mainClass := ""
	for _, f := range zr.File {
		if strings.EqualFold(f.Name, "META-INF/MANIFEST.MF") {
			rc, err := f.Open()
			if err != nil {
				return 0, err
			}
			b, _ := io.ReadAll(io.LimitReader(rc, 256*1024))
			_ = rc.Close()
			mainClass = parseJarManifestMainClass(string(b))
			break
		}
	}

	var classFile *zip.File
	if mainClass != "" {
		want := strings.ReplaceAll(mainClass, ".", "/") + ".class"
		for _, f := range zr.File {
			if f.Name == want {
				classFile = f
				break
			}
		}
	}

	if classFile == nil {
		// Fallback: pick the first top-level class (skip META-INF/ and multi-release classes).
		for _, f := range zr.File {
			nameUpper := strings.ToUpper(f.Name)
			if strings.HasPrefix(nameUpper, "META-INF/") {
				continue
			}
			if !strings.HasSuffix(nameUpper, ".CLASS") {
				continue
			}
			classFile = f
			break
		}
	}
	if classFile == nil {
		return 0, errors.New("jar has no class files")
	}

	rc, err := classFile.Open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()

	var header [8]byte
	if _, err := io.ReadFull(rc, header[:]); err != nil {
		return 0, err
	}
	if binary.BigEndian.Uint32(header[:4]) != 0xCAFEBABE {
		return 0, errors.New("invalid class header")
	}
	classMajor := int(binary.BigEndian.Uint16(header[6:8]))
	javaMajor := classMajor - 44
	if javaMajor <= 0 || javaMajor > 100 {
		return 0, fmt.Errorf("invalid class major=%d", classMajor)
	}
	return javaMajor, nil
}

// parseJarManifestMainClass reads a minimal subset of MANIFEST.MF.
// It also supports continuation lines starting with one space.
func parseJarManifestMainClass(manifest string) string {
	lines := strings.Split(manifest, "\n")
	var curKey string
	var curVal strings.Builder
	flush := func(out map[string]string) {
		if curKey == "" {
			return
		}
		out[curKey] = strings.TrimSpace(curVal.String())
		curKey = ""
		curVal.Reset()
	}

	out := make(map[string]string)
	for _, raw := range lines {
		line := strings.TrimRight(raw, "\r")
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, " ") && curKey != "" {
			curVal.WriteString(strings.TrimPrefix(line, " "))
			continue
		}
		flush(out)
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		curKey = strings.TrimSpace(parts[0])
		curVal.WriteString(strings.TrimSpace(parts[1]))
	}
	flush(out)

	for k, v := range out {
		if strings.EqualFold(k, "Main-Class") {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
