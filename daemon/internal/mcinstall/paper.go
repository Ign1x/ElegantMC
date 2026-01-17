package mcinstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

type PaperJar struct {
	Version string
	Build   int
	Name    string
	URL     string
	SHA256  string
}

type paperVersionResp struct {
	Builds []int `json:"builds"`
}

type paperBuildResp struct {
	Downloads struct {
		Application struct {
			Name   string `json:"name"`
			SHA256 string `json:"sha256"`
		} `json:"application"`
	} `json:"downloads"`
}

func ResolvePaperJar(ctx context.Context, apiBaseURL, version string, build int) (PaperJar, error) {
	version = strings.TrimSpace(version)
	if version == "" {
		return PaperJar{}, errors.New("version is required")
	}

	apiBase := strings.TrimRight(strings.TrimSpace(apiBaseURL), "/")
	if apiBase == "" {
		apiBase = "https://api.papermc.io"
	}

	verURL := apiBase + "/v2/projects/paper/versions/" + url.PathEscape(version)
	var ver paperVersionResp
	if err := fetchJSONLenient(ctx, verURL, &ver); err != nil {
		return PaperJar{}, fmt.Errorf("fetch paper versions: %w", err)
	}

	if len(ver.Builds) == 0 {
		return PaperJar{}, fmt.Errorf("no builds for paper %s", version)
	}

	if build == 0 {
		build = ver.Builds[len(ver.Builds)-1]
	}

	buildURL := apiBase + "/v2/projects/paper/versions/" + url.PathEscape(version) + "/builds/" + strconv.Itoa(build)
	var br paperBuildResp
	if err := fetchJSONLenient(ctx, buildURL, &br); err != nil {
		return PaperJar{}, fmt.Errorf("fetch paper build: %w", err)
	}

	name := strings.TrimSpace(br.Downloads.Application.Name)
	if name == "" {
		return PaperJar{}, errors.New("paper build missing downloads.application.name")
	}

	downloadURL := apiBase + "/v2/projects/paper/versions/" + url.PathEscape(version) + "/builds/" + strconv.Itoa(build) + "/downloads/" + path.Base(name)
	return PaperJar{
		Version: version,
		Build:   build,
		Name:    name,
		URL:     downloadURL,
		SHA256:  strings.TrimSpace(br.Downloads.Application.SHA256),
	}, nil
}

func fetchJSONLenient(ctx context.Context, urlStr string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlStr, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "ElegantMC-Daemon/0.1.0")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	dec := json.NewDecoder(resp.Body)
	return dec.Decode(out)
}

