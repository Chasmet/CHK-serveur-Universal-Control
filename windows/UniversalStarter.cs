// CHK Universal Control Windows launcher: actual offline-capable one-click native EXE.
// Installs Node and a second isolated Tailscale identity from authenticated release artifacts.
// No changes to the existing PC-SALON Tailscale configuration, Serve, Funnel or Godot files.
using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Drawing;
using System.Net;
using System.Reflection;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using System.Collections.Generic;

namespace CHKUniversalControl
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            if (Array.IndexOf(args, "--self-test") >= 0)
            {
                try { MainPanel.SelfTest(); Environment.Exit(0); }
                catch (Exception e) { Console.Error.WriteLine(e.Message); Environment.Exit(1); }
                return;
            }
            bool owned = false;
            using (var single = new Mutex(true, @"Local\CHKUniversalControlNative", out owned))
            {
                if (!owned)
                {
                    MessageBox.Show("CHK SERVEUR PC est déjà lancé sur ce PC. Clique sur son icône près de l'horloge Windows.",
                        "CHK SERVEUR PC", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainPanel());
            }
        }
    }

    sealed class MainPanel : Form
    {
        const string Version = "0.4.0";
        static readonly string Root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CHKUniversalControl");
        static readonly string Runtime = Path.Combine(Root, "runtime-v" + Version);
        static readonly string SettingsFile = Path.Combine(Root, "settings.json");
        static readonly string LogFile = Path.Combine(Root, "universal-diagnostic.log");
        static readonly string NodeFile = Path.Combine(Runtime, "node.exe");
        static readonly string BridgeFile = Path.Combine(Runtime, "tailscale-bridge.exe");
        static readonly string ServerFile = Path.Combine(Runtime, "src", "server.mjs");
        static readonly string ChatURL = "http://127.0.0.1:8787/chat";

        readonly object sync = new object();
        readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        readonly Label status = new Label();
        readonly Label domain = new Label();
        readonly TextBox diagnostics = new TextBox();
        readonly Button authorize = new Button();
        readonly Button copy = new Button();
        readonly NotifyIcon tray = new NotifyIcon();
        readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();
        Process node;
        Process bridge;
        string authUrl = "";
        string publicUrl = "";
        string nodeBaseUrl = "";
        bool busy = false;
        bool exiting = false;
        string lastBridgeError = "";

        public MainPanel()
        {
            Text = "CHK SERVEUR PC - v" + Version + " - MCP universel";
            Icon = SystemIcons.Application;
            BackColor = Color.FromArgb(13, 23, 40);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 10F);
            ClientSize = new Size(670, 680);
            MinimumSize = new Size(600, 640);
            StartPosition = FormStartPosition.CenterScreen;

            var heading = new Label { Text = "CHK SERVEUR PC", Left = 22, Top = 20,
                Width = 630, Height = 38, Font = new Font("Segoe UI", 20F, FontStyle.Bold),
                ForeColor = Color.FromArgb(100, 210, 250) };
            Controls.Add(heading);
            var detail = new Label { Text = "Serveur universel sur ton PC. Pirate Warrior 2 : première application.\nSans Render ni Supabase.",
                Left = 24, Top = 65, Width = 610, Height = 42, ForeColor = Color.LightGray };
            Controls.Add(detail);

            status.Left = 25; status.Top = 114; status.Width = 610; status.Height = 60;
            status.Text = "Préparation du serveur...";
            Controls.Add(status);
            domain.Left = 25; domain.Top = 174; domain.Width = 610; domain.Height = 43;
            domain.Text = "HTTPS public : en attente d'autorisation de la nouvelle identité Tailscale";
            domain.ForeColor = Color.FromArgb(160, 210, 250);
            Controls.Add(domain);

            MakeButton("INSTALLER / DÉMARRER LE SERVEUR", 229, delegate { StartAsync(); });
            authorize.Text = "AUTORISER LE SERVEUR DANS TAILSCALE";
            SetupButton(authorize, 280, delegate {
                string url; lock (sync) { url = authUrl; }
                if (!String.IsNullOrEmpty(url)) OpenBrowser(url);
            });
            authorize.Enabled = false;

            MakeButton("OUVRIR MON TABLEAU DE BORD LOCAL", 330, delegate { OpenBrowser(ChatURL); });
            copy.Text = "COPIER MON LIEN MCP CHATGPT";
            SetupButton(copy, 381, delegate {
                string url; lock (sync) { url = publicUrl; }
                if (String.IsNullOrEmpty(url)) MessageBox.Show("Valide d'abord le nouveau serveur dans Tailscale.", "CHK Universal");
                else Clipboard.SetText(url + "/mcp");
            });
            copy.Enabled = false;
            MakeButton("COPIER MON MOT DE PASSE ADMINISTRATEUR", 431, delegate {
                try {
                    var cfg = Config();
                    Clipboard.SetText(Convert.ToString(cfg["admin_password"]));
                    UpdateStatus("Mot de passe copié. Utilise-le uniquement dans la page d'autorisation CHK.");
                } catch (Exception e) { ShowError(e); }
            });

            MakeButton("VOIR LES ERREURS ET LE DIAGNOSTIC", 485, delegate {
                try {
                    if (!File.Exists(LogFile)) {
                        diagnostics.Text = "Aucune erreur enregistrée.";
                        return;
                    }
                    string text = File.ReadAllText(LogFile, Encoding.UTF8);
                    if (text.Length > 15000) text = text.Substring(text.Length - 15000);
                    diagnostics.Text = Regex.Replace(text, @"\b[a-f0-9]{64}\b", "[CLE MASQUEE]", RegexOptions.IgnoreCase);
                    diagnostics.SelectionStart = diagnostics.TextLength;
                    diagnostics.ScrollToCaret();
                } catch (Exception e) { ShowError(e); }
            });
            diagnostics.Left = 22; diagnostics.Top = 540; diagnostics.Width = 625;
            diagnostics.Height = 115; diagnostics.Multiline = true;
            diagnostics.ReadOnly = true; diagnostics.ScrollBars = ScrollBars.Vertical;
            diagnostics.BackColor = Color.FromArgb(18, 35, 54);
            diagnostics.ForeColor = Color.LightGray;
            diagnostics.Text = "Les erreurs et les étapes de démarrage s'affichent ici.";
            Controls.Add(diagnostics);

            tray.Icon = SystemIcons.Application;
            tray.Text = "CHK SERVEUR PC";
            tray.Visible = true;
            var menu = new ContextMenuStrip();
            menu.Items.Add("Ouvrir le tableau de bord", null, delegate { OpenBrowser(ChatURL); });
            menu.Items.Add("Ouvrir la fenêtre", null, delegate { ShowWindow(); });
            menu.Items.Add("Quitter et arrêter mon serveur universel", null, delegate {
                exiting = true; tray.Visible = false;
                StopChildren();
                Application.Exit();
            });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { ShowWindow(); };
            FormClosing += delegate(object sender, FormClosingEventArgs e) {
                if (!exiting && e.CloseReason == CloseReason.UserClosing) {
                    e.Cancel = true; Hide(); ShowInTaskbar = false;
                    tray.ShowBalloonTip(1000, "CHK Universal", "Le serveur reste actif dans la barre Windows.", ToolTipIcon.Info);
                } else {
                    tick.Stop(); tray.Visible = false;
                    StopChildren();
                }
            };
            Shown += delegate { StartAsync(); };
            tick.Interval = 5000;
            tick.Tick += delegate {
                lock(sync) {
                    authorize.Enabled = !String.IsNullOrEmpty(authUrl);
                    copy.Enabled = !String.IsNullOrEmpty(publicUrl);
                }
            };
            tick.Start();
        }

        void SetupButton(Button button, int top, EventHandler action) {
            button.Left = 25; button.Top = top;
            button.Width = 620; button.Height = 42;
            button.BackColor = Color.FromArgb(43, 159, 220);
            button.ForeColor = Color.White;
            button.FlatStyle = FlatStyle.Flat;
            button.Click += action;
            Controls.Add(button);
        }
        void MakeButton(string label, int top, EventHandler action) {
            var b = new Button { Text = label };
            SetupButton(b, top, action);
        }
        void ShowWindow() {
            if (InvokeRequired) { BeginInvoke((Action)ShowWindow); return; }
            Show(); ShowInTaskbar = true; WindowState = FormWindowState.Normal; Activate();
        }
        void UpdateStatus(string text) {
            Log("STATUS " + text);
            if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)delegate {
                status.Text = text;
                diagnostics.AppendText(Environment.NewLine + DateTime.Now.ToString("HH:mm:ss") + " - " + text);
            });
        }
        static void Log(string message) {
            try {
                Directory.CreateDirectory(Root);
                var redacted = Regex.Replace(message, @"\b[a-f0-9]{64}\b", "[CLE MASQUEE]", RegexOptions.IgnoreCase);
                File.AppendAllText(LogFile, DateTime.Now.ToString("s") + " " + redacted + Environment.NewLine);
            } catch { }
        }
        void ShowError(Exception error) {
            Log(error.ToString());
            UpdateStatus("ERREUR : " + error.Message);
            if (!IsDisposed && IsHandleCreated)
                BeginInvoke((Action)delegate { ShowWindow(); });
        }
        static string RandomSecret(int size) {
            var bytes = new byte[size];
            using(var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        }
        Dictionary<string, object> Config() {
            Directory.CreateDirectory(Root);
            if (File.Exists(SettingsFile)) {
                var old = serializer.DeserializeObject(File.ReadAllText(SettingsFile, Encoding.UTF8)) as Dictionary<string, object>;
                if (old == null || !old.ContainsKey("admin_password") || !old.ContainsKey("jwt_secret") ||
                    Convert.ToString(old["admin_password"]).Length < 16 || Convert.ToString(old["jwt_secret"]).Length < 32)
                    throw new Exception("Configuration existante invalide. Elle n'a pas été effacée.");
                return old;
            }
            var cfg = new Dictionary<string, object>();
            cfg["admin_password"] = RandomSecret(24);
            cfg["jwt_secret"] = RandomSecret(32);
            var path = SettingsFile + ".new";
            File.WriteAllText(path, serializer.Serialize(cfg), new UTF8Encoding(false));
            if (File.Exists(SettingsFile)) { File.Delete(path); return Config(); }
            File.Move(path, SettingsFile);
            return cfg;
        }
        void PersistPublicUrl(string url) {
            var cfg = Config();
            if (Convert.ToString(cfg.ContainsKey("public_url") ? cfg["public_url"] : "") == url) return;
            cfg["public_url"] = url;
            var temp = SettingsFile + ".new";
            File.WriteAllText(temp, serializer.Serialize(cfg), new UTF8Encoding(false));
            File.Replace(temp, SettingsFile, SettingsFile + ".backup");
        }
        static void InstallResources() {
            Directory.CreateDirectory(Runtime);
            if (!File.Exists(NodeFile) || !File.Exists(BridgeFile) || !File.Exists(ServerFile)) {
                using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("chk.runtime")) {
                    if (resource == null) throw new Exception("Le package Windows ne contient pas les programmes nécessaires.");
                    using(var zip = new ZipArchive(resource, ZipArchiveMode.Read)) {
                        foreach (var entry in zip.Entries) {
                            if (String.IsNullOrEmpty(entry.Name)) continue;
                            var path = Path.GetFullPath(Path.Combine(Runtime, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                            if (!path.StartsWith(Path.GetFullPath(Runtime) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                                throw new Exception("Archive invalide : chemin interdit.");
                            Directory.CreateDirectory(Path.GetDirectoryName(path));
                            entry.ExtractToFile(path, true);
                        }
                    }
                }
            }
            if (!File.Exists(NodeFile) || !File.Exists(BridgeFile) || !File.Exists(ServerFile))
                throw new Exception("Installation incomplète : Node, Funnel ou MCP introuvable.");
        }

        void StartAsync() {
            lock(sync) { if(busy) return; busy = true; }
            ThreadPool.QueueUserWorkItem(delegate {
                try {
                    UpdateStatus("Installation du serveur sur ton ordinateur (sans modifier PC-SALON)...");
                    Config();
                    InstallResources();
                    StartNode(false);
                    StartBridge();
                    SaveStartup();
                    UpdateStatus("MCP local actif. Le nouveau nœud Tailscale va demander son autorisation si nécessaire.");
                } catch(Exception e) { ShowError(e); }
                finally { lock(sync) { busy = false; } }
            });
        }

        bool LocalHealthy() {
            try {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8787/health");
                req.Timeout = 700;
                using(var response=req.GetResponse())
                using(var reader = new StreamReader(response.GetResponseStream()))
                    return reader.ReadToEnd().Contains("CHK Universal Control");
            } catch { return false; }
        }

        void StartNode(bool restart) {
            if (restart) {
                if (node != null && !node.HasExited) {
                    try { node.Kill(); node.WaitForExit(3000); } catch { }
                }
            } else if (LocalHealthy()) {
                UpdateStatus("Serveur local 8787 déjà accessible. Je conserve ses données et son processus.");
                return;
            }
            var cfg = Config();
            string baseUrl = Convert.ToString(cfg.ContainsKey("public_url") ? cfg["public_url"] : "http://localhost:8787");
            nodeBaseUrl = baseUrl;
            var start = new ProcessStartInfo(NodeFile, "\"" + ServerFile + "\"") {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Runtime, RedirectStandardOutput = true, RedirectStandardError = true
            };
            start.EnvironmentVariables["HOST"] = "127.0.0.1";
            start.EnvironmentVariables["PORT"] = "8787";
            start.EnvironmentVariables["PUBLIC_BASE_URL"] = baseUrl;
            start.EnvironmentVariables["ADMIN_PASSWORD"] = Convert.ToString(cfg["admin_password"]);
            start.EnvironmentVariables["JWT_SECRET"] = Convert.ToString(cfg["jwt_secret"]);
            start.EnvironmentVariables["DATA_FILE"] = Path.Combine(Root, "data", "server.json");
            start.EnvironmentVariables["OLLAMA_URL"] = "";
            node = new Process { StartInfo = start, EnableRaisingEvents = true };
            node.OutputDataReceived += delegate(object _, DataReceivedEventArgs e) { if (e.Data != null) Log("NODE " + e.Data); };
            node.ErrorDataReceived += delegate(object _, DataReceivedEventArgs e) { if (e.Data != null) Log("NODE " + e.Data); };
            if (!node.Start()) throw new Exception("Windows refuse d'ouvrir Node MCP.");
            node.BeginOutputReadLine(); node.BeginErrorReadLine();
            for (int i=0;i<40;i++) {
                if(LocalHealthy()) { UpdateStatus("MCP universel local actif (127.0.0.1:8787)"); return; }
                if(node.HasExited) throw new Exception("Le moteur Node s'est fermé : voir diagnostic.log.");
                Thread.Sleep(250);
            }
            throw new Exception("Le MCP local n'a pas répondu après démarrage.");
        }

        void StartBridge() {
            if (bridge != null && !bridge.HasExited) return;
            var info = new ProcessStartInfo(BridgeFile, "") {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                WorkingDirectory = Runtime, RedirectStandardOutput = true, RedirectStandardError = true
            };
            info.EnvironmentVariables["CHK_UNIVERSAL_HOME"] = Root;
            lock(sync) { lastBridgeError = ""; authUrl = ""; }
            bridge = new Process { StartInfo = info, EnableRaisingEvents = true };
            bridge.OutputDataReceived += delegate(object _, DataReceivedEventArgs e) { if (e.Data != null) ProcessBridgeLog(e.Data); };
            bridge.ErrorDataReceived += delegate(object _, DataReceivedEventArgs e) { if (e.Data != null) ProcessBridgeLog(e.Data); };
            var launchedBridge = bridge;
            bridge.Exited += delegate {
                // ErrorDataReceived may finish after Exited; show the actionable
                // error from the latest Tailscale message instead of a generic notice.
                Thread.Sleep(300);
                string reason;
                lock (sync) { reason = lastBridgeError; }
                int code;
                try { code = launchedBridge.ExitCode; } catch { code = -1; }
                var detail = "Le tunnel indépendant s'est arrêté (code " + code + ")" +
                    (String.IsNullOrEmpty(reason) ? ". Clique sur VOIR LES ERREURS ET LE DIAGNOSTIC." :
                      " : " + reason);
                Log(detail);
                UpdateStatus(detail);
            };
            if (!bridge.Start()) throw new Exception("Impossible de démarrer l'identité Tailscale indépendante.");
            bridge.BeginOutputReadLine(); bridge.BeginErrorReadLine();
        }
        void ProcessBridgeLog(string text) {
            Log("TSNET " + text);
            if (text.StartsWith("FILE_PROBE_OK=")) {
                UpdateStatus("Dossier Tailscale vérifié : écriture Windows testée.");
            }
            if (text.StartsWith("FILE_PROBE_FAILED=")) {
                UpdateStatus("Ancien dossier Tailscale inaccessible : recherche d'un dossier sûr.");
            }
            if (text.StartsWith("STATE=awaiting_tailscale_authorization")) {
                UpdateStatus("Nouveau serveur Tailscale en préparation. Une autorisation peut être nécessaire.");
            }
            if (text.StartsWith("STATE=tailscale_authenticated")) {
                UpdateStatus("Nouvelle identité Tailscale authentifiée. Ouverture HTTPS 443...");
            }
            if (text.Contains("TAILSCALE_STORAGE_FAILED") || text.Contains("TAILSCALE_START_FAILED") || text.Contains("TAILSCALE_LOGIN_FAILED") ||
                text.Contains("TAILSCALE_DNS_NOT_READY") || text.Contains("FUNNEL_443_FAILED") ||
                text.Contains("FUNNEL_HTTP_FAILED") || text.Contains("TAILSCALE_INVALID_DOMAIN") ||
                text.Contains("panic:") || text.Contains("fatal error:")) {
                lock (sync) { lastBridgeError = text.Length > 300 ? text.Substring(0, 300) : text; }
                UpdateStatus("Diagnostic du tunnel : " + text);
            }
            var auth = Regex.Match(text, @"https://login\.tailscale\.com/[A-Za-z0-9/_?=.-]+");
            if (auth.Success) {
                lock(sync) { authUrl = auth.Value; }
                UpdateStatus("Autorisation Tailscale nécessaire : clique sur AUTORISER LE SERVEUR.");
                if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)delegate { authorize.Enabled = true; ShowWindow(); });
            }
            if (!text.StartsWith("PUBLIC_HTTPS=https://")) return;
            var value = text.Substring("PUBLIC_HTTPS=".Length).Trim();
            if (!Regex.IsMatch(value, @"^https://[a-z0-9.-]+\.ts\.net$")) return;
            ThreadPool.QueueUserWorkItem(delegate {
                try {
                    lock(sync) { publicUrl = value; authUrl = ""; }
                    PersistPublicUrl(value);
                    if (nodeBaseUrl != value) StartNode(true);
                    UpdateStatus("HTTPS 443 du second nœud Tailscale disponible. Vérifie maintenant le lien dans ChatGPT.");
                    if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)delegate {
                        domain.Text = "Adresse universelle : " + value + "/mcp";
                        copy.Enabled = true;
                        authorize.Enabled = false;
                    });
                } catch(Exception e) { ShowError(e); }
            });
        }
        void SaveStartup() {
            var target = Path.Combine(Root, "CHK-SERVEUR-PC-v" + Version + ".exe");
            if (!File.Exists(target)) File.Copy(Assembly.GetExecutingAssembly().Location, target);
            using(var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                key.SetValue("CHKUniversalControl", "\"" + target + "\"", RegistryValueKind.String);
        }
        void StopChildren() {
            try { if (bridge != null && !bridge.HasExited) bridge.Kill(); } catch { }
            try { if (node != null && !node.HasExited) node.Kill(); } catch { }
        }
        static void OpenBrowser(string url) {
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var paths = new [] {
                Path.Combine(pf, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(pf86, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(pf86, "Microsoft", "Edge", "Application", "msedge.exe")
            };
            foreach(var exe in paths) {
                if(!File.Exists(exe))continue;
                try {
                    Process.Start(new ProcessStartInfo(exe, "\"" + url + "\"") { UseShellExecute=false });
                    return;
                } catch { }
            }
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute=true }); }
            catch { MessageBox.Show("Ouvre Chrome et colle ce lien : " + url, "CHK Universal", MessageBoxButtons.OK); }
        }
        public static void SelfTest() {
            using(var input = Assembly.GetExecutingAssembly().GetManifestResourceStream("chk.runtime")) {
                if (input == null) throw new Exception("Embedded runtime missing");
                using(var zip=new ZipArchive(input, ZipArchiveMode.Read)) {
                    if(zip.GetEntry("node.exe")==null || zip.GetEntry("tailscale-bridge.exe")==null ||
                        zip.GetEntry("src/server.mjs")==null || zip.GetEntry("src/godot.mjs")==null ||
                        zip.GetEntry("public/chat.html")==null)
                        throw new Exception("Missing required files in packaged Windows executable");
                }
            }
            if(Version!="0.4.0")throw new Exception("Incorrect Windows launcher version");
        }
    }
}
