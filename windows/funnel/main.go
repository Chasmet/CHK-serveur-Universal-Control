// CHK Universal Funnel: a second independent Tailscale identity on the same Windows PC.
// No changes to the owner's existing Tailscale Serve/Funnel ports, names or routes.
package main

import (
 "encoding/json"
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
 "sync"
 "time"

 "tailscale.com/tsnet"
)

type status struct {
 State string `json:"state"`
 URL string `json:"url,omitempty"`
 AuthURL string `json:"auth_url,omitempty"`
 Message string `json:"message,omitempty"`
 Updated string `json:"updated"`
}

var authPattern=regexp.MustCompile(`https://login\.tailscale\.com/a/[A-Za-z0-9/_-]+`)
var mu sync.Mutex
var statusPath string
var latest status

func report(state, address, auth, message string) {
 mu.Lock()
 defer mu.Unlock()
 if state=="auth_required" && latest.State=="online" { return }
 if state=="online" { auth="" }
 latest=status{State:state,URL:address,AuthURL:auth,Message:message,Updated:time.Now().UTC().Format(time.RFC3339)}
 encoded,err:=json.Marshal(latest)
 if err!=nil { return }
 tmp:=statusPath+".tmp"
 if err=os.WriteFile(tmp,encoded,0600);err==nil { _=os.Rename(tmp,statusPath) }
}

func main() {
 home:=os.Getenv("CHK_UNIVERSAL_HOME")
 if home=="" {
   local:=os.Getenv("LOCALAPPDATA")
   if local=="" { log.Fatal("CHK_UNIVERSAL_HOME or LOCALAPPDATA required") }
   home=filepath.Join(local,"CHKUniversalControl")
 }
 if err:=os.MkdirAll(home,0700);err!=nil { log.Fatal(err) }
 statusPath=filepath.Join(home,"funnel-status.json")
 report("starting","","","Initialisation de la deuxième identité Tailscale (sans toucher à PC-SALON).")
 srv:=&tsnet.Server{
    Dir:filepath.Join(home,"tailscale-identity"),
    Hostname:"chk-universal",
    UserLogf:func(format string,args ...any){
       msg:=fmt.Sprintf(format,args...)
       if link:=authPattern.FindString(msg);link!="" {
          report("auth_required","",link,"Ouvre le lien d'autorisation pour ajouter CHK Universal au réseau Tailscale.")
       }
       // Logs omit the one-time authentication link and other sensitive material.
       if authPattern.MatchString(msg) { log.Print("Tailscale attend la validation de la nouvelle machine.") }
       if strings.Contains(strings.ToLower(msg),"error") && !authPattern.MatchString(msg) {log.Print("Tailscale: ",msg)}
    },
 }
 defer srv.Close()
 ln,err:=srv.ListenFunnel("tcp",":443",tsnet.FunnelOnly())
 if err!=nil {
   report("error","","","Impossible d'activer HTTPS Funnel 443 sur la nouvelle identité : "+err.Error())
   log.Fatal(err)
 }
 defer ln.Close()
 domains:=srv.CertDomains()
 if len(domains)==0 {
   report("error","","","Le certificat HTTPS de la nouvelle identité est indisponible.")
   log.Fatal("no HTTPS domain")
 }
 publicURL:="https://"+domains[0]
 report("online",publicURL,"","Deuxième identité Tailscale en HTTPS 443, indépendante de PC-SALON.")
 target,_:=url.Parse("http://127.0.0.1:8787")
 proxy:=httputil.NewSingleHostReverseProxy(target)
 original:=proxy.Director
 proxy.Director=func(r *http.Request){
   original(r)
   r.Host=target.Host
   r.Header.Del("X-Forwarded-Host")
   r.Header.Del("X-Forwarded-Proto")
   r.Header.Del("X-Forwarded-For")
 }
 proxy.Transport=&http.Transport{
    Proxy:nil,
    DialContext:(&net.Dialer{Timeout:3*time.Second,KeepAlive:30*time.Second}).DialContext,
    MaxIdleConns:40,
    IdleConnTimeout:60*time.Second,
    ResponseHeaderTimeout:60*time.Second,
 }
 proxy.ErrorHandler=func(w http.ResponseWriter,r *http.Request,err error){
    http.Error(w,"Serveur universel local indisponible",http.StatusBadGateway)
 }
 server:=&http.Server{
    ReadHeaderTimeout:10*time.Second,
    ReadTimeout:65*time.Second,
    WriteTimeout:68*time.Second,
    IdleTimeout:60*time.Second,
    MaxHeaderBytes:1<<16,
    Handler:http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
       // Always local-only administration for launcher. Never proxy its port 8794.
       w.Header().Set("X-Content-Type-Options","nosniff")
       w.Header().Set("Referrer-Policy","no-referrer")
       proxy.ServeHTTP(w,r)
    }),
 }
 if err:=server.Serve(ln);err!=nil && err!=http.ErrServerClosed {
    report("error",publicURL,"","Le service HTTPS s'est arrêté : "+err.Error())
    log.Fatal(err)
 }
}
