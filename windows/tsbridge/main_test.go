package main

import (
 "io"
 "net/http"
 "net/http/httptest"
 "testing"
 "os"
 "path/filepath"
 "strings"
)

func TestLoopbackOnly(t *testing.T) {
 for _, raw := range []string{"https://example.com", "http://example.com:8787", "http://127.0.0.1:8791", "http://localhost:1234"} {
  if _, err := privateProxy(raw); err == nil { t.Fatalf("Accepted remote or invalid proxy: %s",raw) }
 }
 if _,err := privateProxy("http://127.0.0.1:8787"); err != nil { t.Fatal(err) }
}

func TestReverseProxy(t *testing.T) {
 local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request) {
  if r.URL.Path != "/mcp" || r.Method != "POST" { t.Errorf("Unexpected request %s %s",r.Method,r.URL.Path) }
  w.Header().Set("Content-Type","application/json")
  _,_ = io.WriteString(w,`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`)
 }))
 defer local.Close()
 // The upstream must be loopback 8787. Verify rejection of alternate local port.
 if _,err := privateProxy(local.URL); err == nil {
   t.Fatal("Reverse proxy should refuse an unapproved local endpoint")
 }
}

func TestAtomicStorageAndPinnedIdentity(t *testing.T) {
    workspace := t.TempDir()
    t.Setenv("LOCALAPPDATA", filepath.Join(workspace, "AppData", "Local"))
    base := filepath.Join(workspace, "CHKUniversalControl")
    path, err := chooseStateDir(base)
    if err != nil { t.Fatal(err) }
    if !strings.Contains(path, "CHK-Serveur-PC-Reseau") {
        t.Fatalf("new standalone Tailscale state should use independent directory, got %s", path)
    }
    if err := probeStateDir(path); err != nil { t.Fatalf("actual atomic write failed: %v", err) }
    second, err := chooseStateDir(base)
    if err != nil || path != second { t.Fatalf("state changed after restart %q, %q: %v", path, second, err) }
    if _,err := os.Stat(filepath.Join(base,"tailscale-state-directory.txt")); err != nil {t.Fatal(err)}
}

func TestExistingTailscaleIdentityNeverReplaced(t *testing.T) {
    workspace := t.TempDir()
    t.Setenv("LOCALAPPDATA", filepath.Join(workspace, "AppData", "Local"))
    base := filepath.Join(workspace, "CHKUniversalControl")
    old := filepath.Join(base,"tsnet")
    if err:=os.MkdirAll(old,0700); err!=nil {t.Fatal(err)}
    original:=[]byte("private existing machine identity")
    if err:=os.WriteFile(filepath.Join(old,"tailscaled.state"),original,0600); err!=nil {t.Fatal(err)}
    selected,err:=chooseStateDir(base)
    if err!=nil {t.Fatal(err)}
    if selected!=old {t.Fatalf("existing node not preserved: %s", selected)}
    current,err:=os.ReadFile(filepath.Join(old,"tailscaled.state"))
    if err!=nil || string(current)!=string(original) {t.Fatal("existing Tailscale state changed")}
}

func TestRejectTamperedIdentityLocation(t *testing.T) {
    workspace:=t.TempDir()
    t.Setenv("LOCALAPPDATA", filepath.Join(workspace,"AppData","Local"))
    base:=filepath.Join(workspace,"CHKUniversalControl")
    if err:=os.MkdirAll(base,0700);err!=nil {t.Fatal(err)}
    if err:=os.WriteFile(filepath.Join(base,"tailscale-state-directory.txt"),[]byte("C:\\Windows\\System32"),0600);err!=nil {t.Fatal(err)}
    if _,err:=chooseStateDir(base);err==nil {t.Fatal("tampered path should be blocked")}
}
