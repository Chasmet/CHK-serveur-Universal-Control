package main

import (
  "os"
  "path/filepath"
  "strings"
  "testing"
  "tailscale.com/atomicfile"
  "tailscale.com/logpolicy"
  "tailscale.com/logtail"
)

func TestFirstRunTailscaleStorage(t *testing.T) {
  dir := filepath.Join(t.TempDir(),"CHK-Network","node")
  if err := probeStateDir(dir); err != nil { t.Fatalf("Windows existing-file atomic replace: %v", err) }
  if err := prepareTsnetStorage(dir); err != nil { t.Fatalf("prepare initial state: %v",err) }
  config := filepath.Join(dir,"tailscaled.log.conf")
  state := filepath.Join(dir,"tailscaled.state")
  data, err := os.ReadFile(config)
  if err != nil { t.Fatal(err) }
  cfg, err := logpolicy.ConfigFromBytes(data)
  if err != nil { t.Fatal(err) }
  if err := cfg.Validate(logtail.CollectionNode); err != nil { t.Fatal(err) }
  if err := atomicfile.WriteFile(state, []byte(`{"_machinekey":"previous-node-preserved"}`),0600); err != nil {
    t.Fatalf("Tailscale state atomic replacement: %v", err)
  }
  if err := prepareTsnetStorage(dir); err != nil { t.Fatal(err) }
  reread, err := os.ReadFile(state)
  if err != nil || !strings.Contains(string(reread),"previous-node-preserved") {
    t.Fatal("Existing node state was overwritten or removed")
  }
  data2,err := os.ReadFile(config)
  if err != nil || string(data) != string(data2) { t.Fatal("Existing Tailscale logging credentials changed") }
}

func TestFirstRunPersistentFolderSelection(t *testing.T) {
  appData:=t.TempDir()
  t.Setenv("LOCALAPPDATA",appData)
  base:=filepath.Join(appData,"CHKUniversalControl")
  dir,err:=chooseStateDir(base)
  if err != nil { t.Fatal(err) }
  if err:=prepareTsnetStorage(dir); err!=nil { t.Fatal(err) }
  selected,err:=chooseStateDir(base)
  if err!=nil || selected!=dir { t.Fatalf("state path changed: %s %s %v",dir,selected,err) }
  if !strings.HasPrefix(strings.ToLower(dir),strings.ToLower(appData)) { t.Fatal("state path escaped app data") }
}
