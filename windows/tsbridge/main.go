// CHK Universal Control: independent Tailscale identity on the same Windows PC.
// Does not change Serve/Funnel settings for the existing PC-SALON node.
// The only upstream is the owner's loopback-only Node MCP server.
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "net"
    "net/http"
    "net/http/httputil"
    "net/url"
    "os"
    "path/filepath"
    "regexp"
    "strings"
    "time"

    "tailscale.com/tsnet"
)

func privateProxy(upstream string) (http.Handler, error) {
    target, err := url.Parse(upstream)
    if err != nil || target.Scheme != "http" || !((target.Hostname() == "127.0.0.1" || target.Hostname() == "localhost") && target.Port() == "8787") {
        return nil, errors.New("upstream must be http://127.0.0.1:8787")
    }
    proxy := &httputil.ReverseProxy{
        Rewrite: func(r *httputil.ProxyRequest) {
            r.SetURL(target)
            r.SetXForwarded()
            r.Out.Header.Del("Forwarded")
            r.Out.Header.Del("X-Forwarded-Host")
            r.Out.Header.Set("X-Forwarded-Proto", "https")
        },
        ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
            log.Printf("PROXY_ERROR=%s", strings.ReplaceAll(err.Error(), "\n", " "))
            http.Error(w, "universal_control_local_unavailable", http.StatusBadGateway)
        },
    }
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("X-Content-Type-Options", "nosniff")
        w.Header().Set("Referrer-Policy", "no-referrer")
        proxy.ServeHTTP(w, r)
    }), nil
}

var loginURL = regexp.MustCompile(`https://login\.tailscale\.com/[a-zA-Z0-9/?=_-]+`)

func main() {
    base := os.Getenv("CHK_UNIVERSAL_HOME")
    if base == "" {
        base = filepath.Join(os.Getenv("LOCALAPPDATA"), "CHKUniversalControl")
    }
    if base == "" {
        log.Fatal("CHK_UNIVERSAL_HOME missing")
    }
    stateDir := filepath.Join(base, "tsnet")
    if err := os.MkdirAll(stateDir, 0700); err != nil {
        log.Fatal(err)
    }
    handler, err := privateProxy("http://127.0.0.1:8787")
    if err != nil {
        log.Fatal(err)
    }

    s := &tsnet.Server{
        Dir: stateDir,
        Hostname: "chk-universal",
        UserLogf: func(format string, args ...any) {
            line := fmt.Sprintf(format, args...)
            if match := loginURL.FindString(line); match != "" {
                fmt.Println("AUTH_URL=" + match)
            }
            log.Printf("TAILSCALE=%s", line)
        },
    }
    defer s.Close()

    // New independent tsnet identity. Crucially, Up blocks until the user
    // authenticates the new node in the browser. Without Up, CertDomains can
    // be empty on the first start, causing the tunnel to exit immediately.
    fmt.Println("STATE=awaiting_tailscale_authorization")
    if err := s.Start(); err != nil {
        log.Fatal("TAILSCALE_START_FAILED: ", err)
    }
    status, err := s.Up(context.Background())
    if err != nil {
        log.Fatal("TAILSCALE_LOGIN_FAILED: ", err)
    }
    if status == nil || status.Self == nil || status.Self.DNSName == "" {
        log.Fatal("TAILSCALE_DNS_NOT_READY")
    }
    domain := strings.TrimSuffix(status.Self.DNSName, ".")
    if !strings.HasSuffix(domain, ".ts.net") {
        log.Fatal("TAILSCALE_INVALID_DOMAIN")
    }
    fmt.Println("STATE=tailscale_authenticated")
    log.Printf("Independent tsnet node authenticated: %s", domain)

    // Only after node authentication, enable public Funnel HTTPS on its own
    // separate virtual Tailscale identity, never on the PC-SALON host.
    listener, err := s.ListenFunnel("tcp", ":443", tsnet.FunnelOnly())
    if err != nil {
        log.Fatal("FUNNEL_443_FAILED: ", err)
    }
    defer listener.Close()
    fmt.Println("PUBLIC_HTTPS=https://" + domain)
    log.Printf("CHK Universal Control remote HTTPS 443 listening on %s", domain)

    server := &http.Server{Handler: handler, ReadHeaderTimeout: 12 * time.Second, IdleTimeout: 75 * time.Second}
    if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
        log.Fatal("FUNNEL_HTTP_FAILED: ", err)
    }
}
