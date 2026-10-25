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

    "tailscale.com/atomicfile"
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

// probeStateDir uses the SAME atomic Windows file-writing primitive used by
// Tailscale's logpolicy.Config.Save. A plain mkdir test did not catch the
// failure on the user's PC. It never overwrites an existing Tailscale file.
func probeStateDir(dir string) error {
    if err := os.MkdirAll(dir, 0700); err != nil {
        return fmt.Errorf("create folder: %w", err)
    }
    info, err := os.Stat(dir)
    if err != nil || !info.IsDir() {
        return fmt.Errorf("not a writable directory: %s: %v", dir, err)
    }
    probe := filepath.Join(dir, ".chk-atomic-write-probe")
    if err := atomicfile.WriteFile(probe, []byte("CHK local storage ready"), 0600); err != nil {
        return fmt.Errorf("Windows atomic write/rename failed: %w", err)
    }
    if err := os.Remove(probe); err != nil {
        return fmt.Errorf("cleanup probe: %w", err)
    }
    return nil
}

func stateExists(dir string) bool {
    for _, name := range []string{"tailscaled.state", "tailscaled.log.conf"} {
        if _, err := os.Stat(filepath.Join(dir, name)); err == nil { return true }
    }
    return false
}

// chooseStateDir preserves a prior authenticated node if present. New
// installations use their own stable LocalAppData folder, separate from
// CHKUniversalControl\tsnet, the path which failed for this installation.
// The chosen path is pinned across upgrades; it cannot change silently.
func chooseStateDir(base string) (string, error) {
    if err := os.MkdirAll(base, 0700); err != nil { return "", err }
    marker := filepath.Join(base, "tailscale-state-directory.txt")
    oldDir := filepath.Join(base, "tsnet")
    localApp := os.Getenv("LOCALAPPDATA")
    if localApp == "" {
        var err error
        localApp, err = os.UserConfigDir()
        if err != nil { return "", err }
    }
    dedicated := filepath.Join(localApp, "CHK-Serveur-PC-Reseau")
    if text, err := os.ReadFile(marker); err == nil {
        selected := filepath.Clean(strings.TrimSpace(string(text)))
        // Refuse untrusted state-folder substitutions from a modified marker.
        if !strings.EqualFold(selected, filepath.Clean(oldDir)) &&
            !strings.EqualFold(selected, filepath.Clean(dedicated)) {
            return "", errors.New("invalid persisted Tailscale state directory")
        }
        if err := probeStateDir(selected); err != nil {
            return "", fmt.Errorf("existing Tailscale identity cannot be written; state preserved: %w", err)
        }
        return selected, nil
    } else if !errors.Is(err, os.ErrNotExist) {
        return "", err
    }
    candidates := []string{dedicated, oldDir}
    if stateExists(oldDir) {
        candidates = []string{oldDir} // do not silently create a different identity
    }
    var reasons []string
    for _, dir := range candidates {
        if err := probeStateDir(dir); err != nil {
            reasons = append(reasons, filepath.Base(dir)+": "+err.Error())
            fmt.Println("FILE_PROBE_FAILED=" + filepath.Base(dir) + ": " + err.Error())
            continue
        }
        if err := atomicfile.WriteFile(marker, []byte(dir+"\n"), 0600); err != nil {
            return "", fmt.Errorf("cannot persist Tailscale state selection: %w", err)
        }
        fmt.Println("FILE_PROBE_OK=" + dir)
        return dir, nil
    }
    return "", errors.New("no writable Tailscale folder; " + strings.Join(reasons, "; "))
}

func main() {
    base := os.Getenv("CHK_UNIVERSAL_HOME")
    if base == "" {
        base = filepath.Join(os.Getenv("LOCALAPPDATA"), "CHKUniversalControl")
    }
    if base == "" {
        log.Fatal("CHK_UNIVERSAL_HOME missing")
    }
    stateDir, err := chooseStateDir(base)
    if err != nil {
        log.Fatal("TAILSCALE_STORAGE_FAILED: ", err)
    }
    if len(os.Args) > 1 && os.Args[1] == "--diagnostic-storage" {
        fmt.Println("STORAGE_TEST_OK")
        return
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
