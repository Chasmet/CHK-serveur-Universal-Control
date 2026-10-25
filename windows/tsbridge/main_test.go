package main

import (
 "io"
 "net/http"
 "net/http/httptest"
 "testing"
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
