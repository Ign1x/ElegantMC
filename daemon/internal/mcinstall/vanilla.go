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
	"strings"
	"time"
)

type VanillaServerJar struct {
	Version string
	URL     string
	SHA1    string
	Size    int64
}

type vanillaManifest struct {
	Versions []struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	} `json:"versions"`
}

type vanillaVersionJSON struct {
	Downloads struct {
		Server struct {
			SHA1 string `json:"sha1"`
			Size int64  `json:"size"`
			URL  string `json:"url"`
		} `json:"server"`
	} `json:"downloads"`
}

func ResolveVanillaServerJar(ctx context.Context, metaBaseURL, dataBaseURL, version string) (VanillaServerJar, error) {
	version = strings.TrimSpace(version)
	if version == "" {
		return VanillaServerJar{}, errors.New("version is required")
	}

	metaBase := strings.TrimRight(strings.TrimSpace(metaBaseURL), "/")
	dataBase := strings.TrimRight(strings.TrimSpace(dataBaseURL), "/")
	if metaBase == "" {
		metaBase = "https://piston-meta.mojang.com"
	}
	if dataBase == "" {
		dataBase = "https://piston-data.mojang.com"
	}

	manifestURL := metaBase + "/mc/game/version_manifest_v2.json"
	var manifest vanillaManifest
	if err := fetchJSON(ctx, manifestURL, &manifest); err != nil {
		return VanillaServerJar{}, fmt.Errorf("fetch manifest: %w", err)
	}

	var versionURL string
	for _, v := range manifest.Versions {
		if v.ID == version {
			versionURL = v.URL
			break
		}
	}
	if versionURL == "" {
		return VanillaServerJar{}, fmt.Errorf("version not found: %s", version)
	}

	versionURL = rewriteIfOfficial(versionURL, metaBase, dataBase)

	var vj vanillaVersionJSON
	if err := fetchJSON(ctx, versionURL, &vj); err != nil {
		return VanillaServerJar{}, fmt.Errorf("fetch version json: %w", err)
	}

	downloadURL := strings.TrimSpace(vj.Downloads.Server.URL)
	if downloadURL == "" {
		return VanillaServerJar{}, errors.New("server download URL missing in version json")
	}

	downloadURL = rewriteIfOfficial(downloadURL, metaBase, dataBase)

	return VanillaServerJar{
		Version: version,
		URL:     downloadURL,
		SHA1:    strings.TrimSpace(vj.Downloads.Server.SHA1),
		Size:    vj.Downloads.Server.Size,
	}, nil
}

func fetchJSON(ctx context.Context, urlStr string, out any) error {
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

func rewriteIfOfficial(rawURL, metaBase, dataBase string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}

	host := strings.ToLower(u.Host)
	switch host {
	case "piston-meta.mojang.com", "launchermeta.mojang.com":
		return rewriteBase(u, metaBase)
	case "piston-data.mojang.com":
		return rewriteBase(u, dataBase)
	default:
		return rawURL
	}
}

func rewriteBase(u *url.URL, baseStr string) string {
	base, err := url.Parse(baseStr)
	if err != nil {
		return u.String()
	}
	nu := *u
	nu.Scheme = base.Scheme
	nu.Host = base.Host

	basePath := strings.TrimRight(base.Path, "/")
	if basePath == "" || basePath == "/" {
		return nu.String()
	}
	nu.Path = path.Join(basePath, strings.TrimLeft(nu.Path, "/"))
	return nu.String()
}
