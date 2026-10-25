// CHK Universal Control MCP - native Windows (.NET Framework 4.8) localhost dashboard.
// Build with official Windows csc.exe. No Python, PyInstaller, Render, or Supabase.
// GUI remains alive; minimized to system tray on close. HTTP panel stays on loopback.
// GitHub Actions embeds the approved Godot Node MCP JavaScript bundle as a resource.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace CHKUniversalNative
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            if (Array.IndexOf(args, "--self-test") >= 0)
            {
                try { Dashboard.SelfTest(); Environment.Exit(0); }
                catch { Environment.Exit(1); }
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Dashboard(Array.IndexOf(args, "--autorun") >= 0));
        }
    }

    sealed class Dashboard : Form
    {
        const string Version = "0.2.0";
        const int PanelPort = 8794;
        const string Host = "127.0.0.1";
        const string PanelUrl = "http://127.0.0.1:8794/";
        static readonly string InstallDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "CHKUniversalControl");
        static readonly string ConfigPath = Path.Combine(InstallDir, "settings.json");
        static readonly string LogPath = Path.Combine(InstallDir, "native-diagnostic.log");
        readonly object gate = new object();
        readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        readonly string uiSecret = Secret(24);
        readonly bool autorun;
        readonly Label lbl;
        readonly Button btnInstall;
        readonly Button btnCopy;
        readonly NotifyIcon tray;
        TcpListener listener;
        Thread listenThread;
        Process node;
        string status = "Site local actif. Clique sur INSTALLER ET CONNECTER.";
        string hostname = "";
        bool busy = false;
        bool publicOk = false;
        bool exiting = false;
        bool localOk = false;

        internal Dashboard(bool startHidden)
        {
            autorun = startHidden;
            Text = "CHK Universal Control — Serveur personnel v" + Version;
            Icon = SystemIcons.Application;
            Size = new Size(590, 400);
            MinimumSize = new Size(535, 360);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(12, 20, 35);
            ForeColor = Color.White;
            Font = new Font("Segoe UI", 10F);
            lbl = new Label {
                Text = "CHARGEMENT DU SERVEUR LOCAL...", AutoSize = false, Left = 24,
                Top = 65, Width = 520, Height = 85, ForeColor = Color.LightSkyBlue
            };
            var heading = new Label {
                Text = "CHK UNIVERSAL CONTROL", Left = 24, Top = 20,
                Width = 520, Height = 35, Font = new Font("Segoe UI", 17, FontStyle.Bold)
            };
            btnInstall = MakeButton("INSTALLER ET CONNECTER", 160, delegate { StartInstall(); });
            var btnWeb = MakeButton("OUVRIR LE SITE LOCAL", 205, delegate { OpenWeb(); });
            btnCopy = MakeButton("COPIER MON LIEN CHATGPT", 250, delegate { CopyChat(); });
            var btnSite = MakeButton("COPIER L'ADRESSE DU SITE LOCAL", 295, delegate { CopyLocalSite(); });
            Controls.Add(heading); Controls.Add(lbl);
            Controls.Add(btnInstall); Controls.Add(btnWeb); Controls.Add(btnCopy); Controls.Add(btnSite);
            tray = new NotifyIcon {
                Icon = SystemIcons.Application, Visible = true,
                Text = "CHK Universal Control MCP - PC personnel"
            };
            var menu = new ContextMenuStrip();
            menu.Items.Add("Ouvrir CHK Universal Control", null, delegate { ShowPanel(); });
            menu.Items.Add("Ouvrir le site local", null, delegate { OpenWeb(); });
            menu.Items.Add("Quitter complètement", null, delegate {
                exiting = true; tray.Visible = false; Application.Exit();
            });
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { ShowPanel(); };
            FormClosing += OnClosing;
            Shown += delegate {
                try {
                    StartLocalPanel();
                    if (!autorun) OpenWeb();
                    else {
                        Hide();
                        ShowInTaskbar = false;
                        ThreadPool.QueueUserWorkItem(delegate { RecoverNode(); });
                    }
                } catch (Exception e) { Fail("Le serveur web ne démarre pas : " + e.Message, e); }
            };
        }

        Button MakeButton(string text, int top, EventHandler handler)
        {
            var b = new Button { Text = text, Left = 24, Top = top,
                                 Height = 39, Width = 520, BackColor = Color.LightSkyBlue,
                                 ForeColor = Color.Black, FlatStyle = FlatStyle.Flat };
            b.Click += handler;
            return b;
        }
        void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (!exiting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                tray.ShowBalloonTip(1500, "CHK Universal Control", "Le serveur continue en arrière-plan.",
                                    ToolTipIcon.Info);
            }
            else {
                try { if (listener != null) listener.Stop(); } catch {}
                tray.Visible = false;
            }
        }
        void ShowPanel()
        {
            if (InvokeRequired) { BeginInvoke((Action)ShowPanel); return; }
            Show(); WindowState = FormWindowState.Normal; ShowInTaskbar = true;
            Activate();
        }
        /// <summary>
        /// Windows may return REGDB_E_CLASSNOTREG (0x80040154) when the HTTP
        /// URL file association is broken even though Chrome is installed.
        /// Launch known installed browsers by absolute exe path FIRST,
        /// without Windows URL/protocol COM associations.
        /// </summary>
        static IEnumerable<string> BrowserExecutables()
        {
            var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!String.IsNullOrEmpty(pf))
            {
                yield return Path.Combine(pf, "Google", "Chrome", "Application", "chrome.exe");
                yield return Path.Combine(pf, "Microsoft", "Edge", "Application", "msedge.exe");
                yield return Path.Combine(pf, "Mozilla Firefox", "firefox.exe");
            }
            if (!String.IsNullOrEmpty(pf86))
            {
                yield return Path.Combine(pf86, "Google", "Chrome", "Application", "chrome.exe");
                yield return Path.Combine(pf86, "Microsoft", "Edge", "Application", "msedge.exe");
                yield return Path.Combine(pf86, "Mozilla Firefox", "firefox.exe");
            }
            if (!String.IsNullOrEmpty(local))
                yield return Path.Combine(local, "Google", "Chrome", "Application", "chrome.exe");
        }
        void CopyLocalSite()
        {
            try
            {
                Clipboard.SetText(PanelUrl);
                Message("Adresse du site copiée. Ouvre Chrome et colle : " + PanelUrl);
            }
            catch (Exception ex)
            {
                Log(ex);
                Message("Adresse du site à saisir dans Chrome : " + PanelUrl);
            }
        }
        void OpenWeb()
        {
            // Unlike Process.Start(PanelUrl), this does not depend on
            // the damaged URL handler that the user's Windows reports.
            foreach (var browser in BrowserExecutables())
            {
                if (!File.Exists(browser)) continue;
                try
                {
                    Process.Start(new ProcessStartInfo(browser, "\"" + PanelUrl + "\"")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = false
                    });
                    Message("Navigateur ouvert. Site local : " + PanelUrl);
                    return;
                }
                catch (Exception ex) { Log(ex); }
            }
            // ShellExecute is ONLY a secondary fallback, never the default.
            try
            {
                Process.Start(new ProcessStartInfo(PanelUrl) { UseShellExecute = true });
                Message("Navigateur ouvert. Site local : " + PanelUrl);
                return;
            }
            catch (Exception ex)
            {
                Log(ex);
                // A broken Windows browser association must NOT mark the
                // MCP as failed, rotate keys or close the panel.
                ShowPanel();
                Message("Le site est actif mais Windows ne lance pas Chrome automatiquement. "
                      + "Ouvre Chrome toi-même et colle : " + PanelUrl
                      + "  (bouton COPIER L'ADRESSE DU SITE LOCAL).");
            }
        }
        void Message(string msg)
        {
            lock(gate) { status = msg; }
            try {
                if (!IsDisposed && IsHandleCreated)
                    BeginInvoke((Action)delegate { lbl.Text = msg; });
            } catch { }
        }
        void Fail(string msg, Exception e)
        {
            Log(e);
            lock(gate) { status = "ERREUR : " + msg; busy = false; publicOk = false; }
            Message("ERREUR : " + msg);
            try {
                if (!IsDisposed && IsHandleCreated) BeginInvoke((Action)delegate {
                    ShowPanel();
                    MessageBox.Show(this, msg + "\n\nRapport : " + LogPath,
                        "CHK Universal Control — erreur visible", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            } catch {}
        }
        static void Log(Exception e)
        {
            try {
                Directory.CreateDirectory(InstallDir);
                var text = Regex.Replace(e.ToString(),
                    @"\b[0-9a-fA-F]{64}\b", "[CLE MASQUEE]");
                File.AppendAllText(LogPath,
                    DateTime.Now.ToString("s") + " | " + text + Environment.NewLine);
            } catch {}
        }

        static string Secret(int length)
        {
            byte[] data = new byte[length];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(data);
            return BitConverter.ToString(data).Replace("-", "").ToLowerInvariant();
        }
        Dictionary<string, object> Config()
        {
            Directory.CreateDirectory(InstallDir);
            if (File.Exists(ConfigPath))
            {
                var old = serializer.DeserializeObject(File.ReadAllText(ConfigPath, Encoding.UTF8)) as Dictionary<string, object>;
                if (old == null || !old.ContainsKey("admin_password") || !old.ContainsKey("jwt_secret"))
                    throw new Exception("Configuration privée invalide. Aucune donnée effacée.");
                if (Convert.ToString(old["admin_password"]).Length < 16 || Convert.ToString(old["jwt_secret"]).Length < 32)
                    throw new Exception("Secrets invalides. Aucune donnée effacée.");
                return old;
            }
            var config = new Dictionary<string, object>();
            config["admin_password"] = Secret(24);
            config["jwt_secret"] = Secret(32);
            config["local_port"] = 8787;
            config["funnel_port"] = 443;
            using(var fs = new FileStream(ConfigPath, FileMode.CreateNew, FileAccess.Write))
            using(var w = new StreamWriter(fs, new UTF8Encoding(false))) w.Write(serializer.Serialize(config));
            return config;
        }
        static string GetTool(string filename)
        {
            string path = Environment.GetEnvironmentVariable("ProgramFiles");
            var attempts = new [] {
                Path.Combine(path ?? @"C:\Program Files", "Tailscale", filename),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tailscale", filename),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Tailscale", filename)
            };
            foreach(var candidate in attempts) if (File.Exists(candidate)) return candidate;
            throw new Exception("Tailscale n'est pas trouvé. Ouvre Tailscale sur ton PC.");
        }
        static string Run(string program, string arguments, int timeoutSeconds)
        {
            var psi = new ProcessStartInfo(program, arguments) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using(var p = Process.Start(psi))
            {
                // Both stdout and stderr are consumed asynchronously to avoid a full-pipe deadlock.
                var output = new StringBuilder();
                var error = new StringBuilder();
                p.OutputDataReceived += delegate(object a, DataReceivedEventArgs e) {
                    if (e.Data != null) lock(output) output.AppendLine(e.Data);
                };
                p.ErrorDataReceived += delegate(object a, DataReceivedEventArgs e) {
                    if (e.Data != null) lock(error) error.AppendLine(e.Data);
                };
                p.BeginOutputReadLine(); p.BeginErrorReadLine();
                if (!p.WaitForExit(timeoutSeconds * 1000)) {
                    try { p.Kill(); } catch {}
                    throw new Exception("Tailscale ne répond pas (" + timeoutSeconds + " secondes).");
                }
                p.WaitForExit();
                var detail = output.ToString() + "\n" + error.ToString();
                if (p.ExitCode != 0) throw new Exception("Commande Tailscale refusée : " + detail.Trim().Substring(0, Math.Min(detail.Trim().Length, 340)));
                return detail;
            }
        }
        string TailscaleName(string tailscale)
        {
            string data = Run(tailscale, "status --json", 20);
            var match = Regex.Match(data, "\"DNSName\"\\s*:\\s*\"([a-zA-Z0-9.-]+\\.ts\\.net)\\.?\"");
            if (!match.Success) throw new Exception("Tailscale est déconnecté ou MagicDNS est indisponible.");
            return match.Groups[1].Value.ToLowerInvariant();
        }
        string FunnelState(string tailscale)
        {
            // Refuse a 443 conflict. Never reset Funnel: keep 8443 and 10000 untouched.
            string data = Run(tailscale, "serve status --json", 15);
            if (!Regex.IsMatch(data, @"(?<![0-9])443(?![0-9])")) return "empty";
            return data.Contains("127.0.0.1:8787") || data.Contains("localhost:8787") ? "ours" : "occupied";
        }
        static bool LocalNodeOk()
        {
            try {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8787/health");
                req.Timeout = 1500;
                using(var res = req.GetResponse())
                using(var rd = new StreamReader(res.GetResponseStream()))
                    return rd.ReadToEnd().Contains("CHK Universal Control");
            } catch { return false; }
        }
        void RecoverNode()
        {
            try {
                var nodeExe = Path.Combine(InstallDir, "runtime-v0.2.0", "node.exe");
                var script = Path.Combine(InstallDir, "runtime-v0.2.0", "src", "server.mjs");
                if(File.Exists(nodeExe) && File.Exists(script) && File.Exists(ConfigPath))
                    LaunchNode(Config(), nodeExe, script);
            } catch(Exception e) { Log(e); }
        }
        void InstallNode(Dictionary<string, object> cfg)
        {
            var root = Path.Combine(InstallDir, "runtime-v0.2.0");
            Directory.CreateDirectory(root);
            var nodeExe = Path.Combine(root, "node.exe");
            if (!File.Exists(nodeExe))
            {
                Message("Téléchargement Node.js officiel vérifié...");
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                const string host = "https://nodejs.org/dist/v22.16.0/";
                const string zipName = "node-v22.16.0-win-x64.zip";
                var sums = Path.Combine(root, "SHASUMS256.txt");
                var archive = Path.Combine(root, "node.zip");
                using(var web = new WebClient()) {
                    web.DownloadFile(host+"SHASUMS256.txt", sums);
                    web.DownloadFile(host+zipName, archive);
                }
                string expected = null;
                foreach(var line in File.ReadAllLines(sums))
                    if(line.Trim().EndsWith(zipName, StringComparison.OrdinalIgnoreCase))
                        expected=line.Trim().Substring(0,64).ToLowerInvariant();
                if(expected==null) throw new Exception("SHA256 Node officiel introuvable.");
                string actual;
                using(var fs=File.OpenRead(archive))
                using(var sha=SHA256.Create())
                    actual=BitConverter.ToString(sha.ComputeHash(fs)).Replace("-","").ToLowerInvariant();
                if(expected!=actual) throw new Exception("Archive Node non conforme (SHA256).");
                using(var zip=ZipFile.OpenRead(archive)) {
                    ZipArchiveEntry exe=null;
                    foreach(var entry in zip.Entries)
                        if(entry.FullName.Replace("\\","/").EndsWith("/node.exe",StringComparison.OrdinalIgnoreCase))
                            {exe=entry;break;}
                    if(exe==null) throw new Exception("Node.exe absent de l'archive officielle.");
                    exe.ExtractToFile(nodeExe);
                }
                try{File.Delete(archive);}catch{}
            }
            var script=Path.Combine(root,"src","server.mjs");
            if(!File.Exists(script)) {
                using(var embedded=Assembly.GetExecutingAssembly().GetManifestResourceStream("chk.package")) {
                    if(embedded==null) throw new Exception("Package serveur universel absent.");
                    using(var zip=new ZipArchive(embedded,ZipArchiveMode.Read)) {
                        foreach(var entry in zip.Entries) {
                            if(String.IsNullOrEmpty(entry.Name)) continue;
                            var dest=Path.GetFullPath(Path.Combine(root,entry.FullName.Replace('/',Path.DirectorySeparatorChar)));
                            if(!dest.StartsWith(Path.GetFullPath(root)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))
                                throw new Exception("Chemin non autorisé dans le package.");
                            Directory.CreateDirectory(Path.GetDirectoryName(dest));
                            entry.ExtractToFile(dest,true);
                        }
                    }
                }
            }
            if(!File.Exists(script)) throw new Exception("Source serveur introuvable dans le package.");
            Message("Démarrage du serveur MCP universel...");
            LaunchNode(cfg,nodeExe,script);
        }
        void LaunchNode(Dictionary<string,object> cfg,string nodeExe,string script)
        {
            if(LocalNodeOk()){localOk=true;return;}
            string domain=Convert.ToString(cfg.ContainsKey("hostname")?cfg["hostname"]:"");
            var psi=new ProcessStartInfo(nodeExe,"\""+script+"\"") {
                UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,
                WorkingDirectory=Path.GetDirectoryName(Path.GetDirectoryName(script))
            };
            psi.EnvironmentVariables["HOST"]="127.0.0.1";
            psi.EnvironmentVariables["PORT"]="8787";
            psi.EnvironmentVariables["PUBLIC_BASE_URL"]=String.IsNullOrEmpty(domain)?"http://localhost:8787":"https://"+domain;
            psi.EnvironmentVariables["ADMIN_PASSWORD"]=Convert.ToString(cfg["admin_password"]);
            psi.EnvironmentVariables["JWT_SECRET"]=Convert.ToString(cfg["jwt_secret"]);
            psi.EnvironmentVariables["DATA_FILE"]=Path.Combine(InstallDir,"data","server.json");
            psi.EnvironmentVariables["OLLAMA_URL"]="";
            node=Process.Start(psi);
            for(int i=0;i<50;i++){
                if(LocalNodeOk()){localOk=true;return;}
                if(node.HasExited)throw new Exception("Node s'est arrêté (code "+node.ExitCode+").");
                Thread.Sleep(350);
            }
            throw new Exception("Serveur MCP local 8787 ne répond pas.");
        }
        void VerifyPublic(string name,Dictionary<string,object> cfg)
        {
            // This checks HTTPS from the PC, not from ChatGPT itself.
            ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
            var root="https://"+name;
            string[] paths={"/health","/.well-known/oauth-protected-resource"};
            string[] expected={"CHK Universal Control","authorization_servers"};
            for(int i=0;i<paths.Length;i++){
                try {
                    var request=(HttpWebRequest)WebRequest.Create(root+paths[i]);
                    request.Timeout=14000;request.ReadWriteTimeout=14000;
                    using(var response=(HttpWebResponse)request.GetResponse())
                    using(var reader=new StreamReader(response.GetResponseStream()))
                        if(response.StatusCode!=HttpStatusCode.OK||!reader.ReadToEnd().Contains(expected[i]))
                            throw new Exception("Réponse HTTPS incorrecte sur "+paths[i]);
                }catch(WebException e){
                    throw new Exception("HTTPS Funnel 443 inaccessible : "+e.Status+
                        ". Anciennes routes conservées. Voir diagnostic.",e);
                }
            }
        }
        void StartInstall()
        {
            lock(gate){if(busy)return;busy=true;publicOk=false;status="Installation sur ton PC...";}
            ThreadPool.QueueUserWorkItem(delegate{
                try{
                    Message("Lecture Tailscale existant...");
                    var tailscale=GetTool("tailscale.exe");
                    var name=TailscaleName(tailscale);
                    var state=FunnelState(tailscale);
                    if(state=="occupied")throw new Exception("Port Funnel 443 occupé par un autre service : aucune modification.");
                    var cfg=Config();
                    cfg["hostname"]=name;
                    File.WriteAllText(ConfigPath,serializer.Serialize(cfg),Encoding.UTF8);
                    InstallNode(cfg);
                    if(state=="empty"){
                        Message("Activation Funnel HTTPS 443 (sans modifier 8443/10000)...");
                        Run(tailscale,"funnel --bg --yes --https=443 http://127.0.0.1:8787",50);
                    }
                    Message("Contrôle public HTTPS 443...");
                    VerifyPublic(name,cfg);
                    hostname=name;
                    lock(gate){busy=false;publicOk=true;}
                    Message("Serveur universel HTTPS 443 opérationnel pour les tests ChatGPT.");
                    SaveAutostart();
                }catch(Exception e){Fail(e.Message,e);}
            });
        }
        void SaveAutostart()
        {
            try{
                var dir=Path.Combine(InstallDir,"runtime-v0.2.0");
                Directory.CreateDirectory(dir);
                var path=Path.Combine(dir,"CHK-Universal-Control.exe");
                if(!File.Exists(path))File.Copy(Assembly.GetExecutingAssembly().Location,path);
                using(var key=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                    key.SetValue("CHKUniversalControl","\""+path+"\" --autorun",RegistryValueKind.String);
            }catch(Exception e){Log(e);}
        }
        void CopyChat()
        {
            lock(gate){if(!publicOk){Message("HTTPS 443 non vérifié. Voir les erreurs.");return;}}
            try{Clipboard.SetText("https://"+hostname+"/mcp");Message("Lien universel MCP copié.");}
            catch(Exception e){Fail("Erreur de copie : "+e.Message,e);}
        }
        void StartLocalPanel()
        {
            listener = new TcpListener(IPAddress.Loopback, PanelPort);
            listener.Start(8);
            listenThread = new Thread(ServeLoop) { IsBackground=true,Name="CHK Universal Control localhost" };
            listenThread.Start();
            Message("Site local actif : " + PanelUrl);
        }
        void ServeLoop()
        {
            while (!exiting) {
                try {
                    var socket = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(delegate { Respond(socket); });
                }
                catch(SocketException e) { if (!exiting) Log(e); break; }
                catch(ObjectDisposedException) { break; }
                catch(Exception e) { Log(e); Thread.Sleep(400); }
            }
        }
        static string HeaderValue(Dictionary<string,string> headers,string key)
        {
            string value;return headers.TryGetValue(key,out value)?value:"";
        }
        void Respond(TcpClient socket)
        {
            using(socket)
            {
                try {
                    socket.ReceiveTimeout=4000;socket.SendTimeout=4000;
                    var stream=socket.GetStream();
                    var reader=new StreamReader(stream,new UTF8Encoding(false),false,4096,true);
                    var line=reader.ReadLine();
                    if (line==null || line.Length>1800) return;
                    var parts=line.Split(' ');
                    if(parts.Length<2)return;
                    string verb=parts[0],route=parts[1].Split('?')[0];
                    var h=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
                    string head;int count=0;
                    while((head=reader.ReadLine())!=null && head.Length>0) {
                        count+=head.Length; if (count>16000) return;
                        int at=head.IndexOf(':');
                        if(at>0)h[head.Substring(0,at).Trim()]=head.Substring(at+1).Trim();
                    }
                    string browserHost=HeaderValue(h,"Host");
                    if(browserHost!="127.0.0.1:8792" && browserHost!="localhost:8792") {
                        Reply(stream,403,"application/json","{\"error\":\"Host local requis\"}");return;
                    }
                    if(verb=="GET" && route=="/") {
                        Reply(stream,200,"text/html; charset=utf-8",WebPage().Replace("__UI_TOKEN__",uiSecret));return;
                    }
                    if(verb=="GET" && route=="/api/health") {
                        Reply(stream,200,"application/json","{\"name\":\"CHK Universal Control Native\",\"version\":\"0.2.0\"}");return;
                    }
                    if(verb=="GET" && route=="/api/status") {
                        bool running,publicReady;string msg;
                        lock(gate){running=busy;publicReady=publicOk;msg=status;}
                        Reply(stream,200,"application/json",serializer.Serialize(new {
                            message=msg,busy=running,public_ok=publicReady,
                            local_ok=LocalNodeOk(),configured=File.Exists(ConfigPath),
                            version=Version
                        }));return;
                    }
                    if(verb!="POST") { Reply(stream,404,"application/json","{\"error\":\"Not Found\"}");return; }
                    string origin=HeaderValue(h,"Origin");
                    if(origin!="" && origin!="http://127.0.0.1:8792" && origin!="http://localhost:8792") {
                        Reply(stream,403,"application/json","{\"error\":\"Origine refusée\"}");return;
                    }
                    if(HeaderValue(h,"X-CHK-UI")!=uiSecret) {
                        Reply(stream,403,"application/json","{\"error\":\"Jeton local incorrect\"}");return;
                    }
                    if(route=="/api/install") {
                        StartInstall();
                        Reply(stream,200,"application/json","{\"ok\":true}");return;
                    }
                    if(route=="/api/diagnostic") {
                        var report=File.Exists(LogPath)?File.ReadAllText(LogPath):"Aucun diagnostic.";
                        if(report.Length>10000)report=report.Substring(report.Length-10000);
                        report=Regex.Replace(report,@"\b[a-f0-9]{64}\b","[CLE MASQUEE]",RegexOptions.IgnoreCase);
                        Reply(stream,200,"application/json",serializer.Serialize(new{report=report}));return;
                    }
                    if(route=="/api/copy-chat" || route=="/api/copy-password" || route=="/api/copy-universal_url") {
                        bool publicReady;string name;
                        lock(gate){publicReady=publicOk;name=hostname;}
                        if(route!="/api/copy-password" && !publicReady) {
                            Reply(stream,409,"application/json","{\"error\":\"Acces public non verifie\"}");return;
                        }
                        var cfg=Config();
                        string url=route=="/api/copy-chat"?"https://"+name+"/mcp":
                                  route=="/api/copy-password"?Convert.ToString(cfg["admin_password"]):
                                  "https://"+name;
                        Reply(stream,200,"application/json",serializer.Serialize(new{value=url}));return;
                    }
                    Reply(stream,404,"application/json","{\"error\":\"Commande inconnue\"}");
                } catch(Exception e) { Log(e); }
            }
        }
        static void Reply(NetworkStream stream,int code,string mime,string value)
        {
            var bytes=Encoding.UTF8.GetBytes(value);
            string reason=code==200?"OK":code==403?"Forbidden":code==409?"Conflict":"Not Found";
            string head="HTTP/1.1 "+code+" "+reason+"\r\nContent-Type: "+mime+
                        "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"+
                        "X-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\n"+
                        "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'\r\n"+
                        "Connection: close\r\nContent-Length: "+bytes.Length+"\r\n\r\n";
            var h=Encoding.ASCII.GetBytes(head);
            stream.Write(h,0,h.Length);stream.Write(bytes,0,bytes.Length);stream.Flush();
        }
        string WebPage()
        {
            using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("chk.web"))
            {
                if(stream==null)throw new Exception("Ressource de page web manquante.");
                using(var reader=new StreamReader(stream,Encoding.UTF8))
                    return reader.ReadToEnd();
            }
        }
        internal static void SelfTest()
        {
            if(PanelPort!=8792 || Version!="0.2.0") throw new Exception("Version invalide");
            if(String.IsNullOrEmpty(Secret(32)))throw new Exception("RNG fail");
            using(var r=Assembly.GetExecutingAssembly().GetManifestResourceStream("chk.web"))
                if(r==null || r.Length<1000)throw new Exception("Ressource web absente");
            using(var r=Assembly.GetExecutingAssembly().GetManifestResourceStream("chk.package"))
                if(r==null || r.Length<500)throw new Exception("Ressource du serveur universel absente");
        }
    }
}
