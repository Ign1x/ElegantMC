package frp

import "testing"

func TestGenerateINI_Minimal(t *testing.T) {
	ini, err := GenerateINI(ProxyConfig{
		Name:       "mc",
		ServerAddr: "frp.example.com",
		ServerPort: 7000,
		LocalIP:    "127.0.0.1",
		LocalPort:  25565,
		RemotePort: 25566,
		Token:      "tok",
	})
	if err != nil {
		t.Fatalf("GenerateINI() error: %v", err)
	}
	if !containsAll(ini,
		"[common]",
		"server_addr = frp.example.com",
		"server_port = 7000",
		"token = tok",
		"[mc]",
		"type = tcp",
		"local_ip = 127.0.0.1",
		"local_port = 25565",
		"remote_port = 25566",
	) {
		t.Fatalf("unexpected ini:\n%s", ini)
	}
}

func TestGenerateINI_RemotePortZeroOmitted(t *testing.T) {
	ini, err := GenerateINI(ProxyConfig{
		Name:       "mc",
		ServerAddr: "frp.example.com",
		ServerPort: 7000,
		LocalIP:    "127.0.0.1",
		LocalPort:  25565,
		RemotePort: 0,
	})
	if err != nil {
		t.Fatalf("GenerateINI() error: %v", err)
	}
	if containsAll(ini, "remote_port") {
		t.Fatalf("expected remote_port omitted, got:\n%s", ini)
	}
}

func TestGenerateINI_Validation(t *testing.T) {
	_, err := GenerateINI(ProxyConfig{})
	if err == nil {
		t.Fatalf("expected error")
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !contains(s, sub) {
			return false
		}
	}
	return true
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	// strings.Index, inlined to keep test deps minimal.
outer:
	for i := 0; i+len(sub) <= len(s); i++ {
		for j := 0; j < len(sub); j++ {
			if s[i+j] != sub[j] {
				continue outer
			}
		}
		return i
	}
	return -1
}

