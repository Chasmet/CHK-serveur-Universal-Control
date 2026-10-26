let token = "";
const $ = id => document.getElementById(id);
const notice = message => { $("notice").textContent = message; };
function line(role, content) {
  const el = document.createElement("div");
  el.className = "line";
  const title = document.createElement("div");
  title.className = "role";
  title.textContent = role;
  const text = document.createElement("div");
  text.textContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  el.append(title, text);
  $("messages").appendChild(el);
  $("messages").scrollTop = $("messages").scrollHeight;
}
async function request(path, body, method) {
  const res = await fetch(path, { method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || "HTTP " + res.status);
  return data;
}
$("loginform").onsubmit = async event => {
  event.preventDefault();
  try {
    const data = await request("/api/login", { password: $("password").value });
    token = data.access_token;
    $("password").value = "";
    $("loginpanel").hidden = true;
    $("chatpanel").hidden = false;
    $("status").textContent = "Connecté";
    notice("");
  } catch (error) { notice(error.message); }
};
$("chatform").onsubmit = async event => {
  event.preventDefault();
  const msg = $("message").value.trim();
  if (!msg) return;
  $("message").value = "";
  line("Vous", msg);
  $("chatform").querySelector("button").disabled = true;
  try {
    const result = await request("/api/chat", { message: msg });
    line("CHK AI", result.reply);
    if (result.tools?.length) line("Outils utilisés", result.tools);
    notice("");
  } catch (error) { line("Erreur", error.message); }
  finally { $("chatform").querySelector("button").disabled = false; }
};
$("apps").onclick = async () => {
  try {
    const response = await request("/api/apps"); line("Applications enregistrées", response.apps);
    if(response.next_offset !== null) {
      const more=document.createElement("button");more.textContent="Applications suivantes";
      let offset=response.next_offset;
      more.onclick=async()=>{try{
        const page=await request("/api/apps?offset="+offset);line("Applications enregistrées",page.apps);
        offset=page.next_offset;more.disabled=offset===null;
      }catch(e){notice(e.message);}};
      $("messages").appendChild(more);
    }
  }
  catch (error) { notice(error.message); }
};

$("tasks").onclick = async () => {
  try {
    const tasks = (await request("/api/tasks")).tasks;
    line("Tâches et statuts", tasks);
    for (const task of tasks.filter(item => item.state === "pending_approval")) {
      const btn = document.createElement("button");
      btn.textContent = "Approuver " + task.action + " / " + task.app_id + " (" + task.id.slice(0, 8) + ")";
      btn.style.margin = "8px";
      btn.onclick = async () => {
        if (!window.confirm("Autoriser cette action ?\n" + JSON.stringify({ app_id: task.app_id, action: task.action, args: (task.args || "non affichés") }, null, 2))) return;
        try {
          const outcome = await request("/api/tasks/" + task.id + "/approve", {});
          line("Validation effectuée", outcome.task);
          btn.disabled = true;
        } catch (e) { notice(e.message); }
      };
      $("messages").appendChild(btn);
    }
  } catch (error) { notice(error.message); }
};

let connectorOffset=0,connectorNext=null;
function node(tag,text){const e=document.createElement(tag);if(text)e.textContent=text;return e;}
async function loadConnectors(offset=0){
  try{
    const data=await request('/api/connectors?offset='+offset+'&query='+encodeURIComponent($("connectorquery").value));
    connectorOffset=offset;connectorNext=data.next_offset;$("connectorrows").replaceChildren();
    $("connectorpage").textContent=data.total?`${offset+1}–${offset+data.connectors.length} / ${data.total}`:'Aucun connecteur';
    $("connectorprev").disabled=offset===0;$("connectornext").disabled=connectorNext===null;
    for(const c of data.connectors){
      const card=node('details');card.className='line';
      card.append(node('summary',`${c.name||'ChatGPT'} · ${c.enabled?'activé':'désactivé'} · ${c.id.slice(-8)}`));
      const label=node('label','Nom du connecteur');const name=node('input');name.value=c.name||'';name.maxLength=80;label.append(name);card.append(label);
      card.append(node('p','Identifiant : '+c.id));
      const enabled=node('input');enabled.type='checkbox';enabled.checked=c.enabled;enabled.style.width='auto';
      const enabledLabel=node('label',' Activer ce connecteur');enabledLabel.prepend(enabled);card.append(enabledLabel);
      const all=node('input');all.type='checkbox';all.checked=c.app_ids===null;all.style.width='auto';
      const allLabel=node('label',' Autoriser toutes mes applications');allLabel.prepend(all);card.append(node('br'),allLabel);
      const selection=new Set(c.app_ids||[]);const count=node('p');const updateCount=()=>{count.textContent=all.checked?'Toutes les applications sont autorisées':selection.size+' application(s) autorisée(s)';};
      all.onchange=updateCount;updateCount();card.append(count);
      const search=node('input');search.type='search';search.placeholder='Chercher une application par son nom';search.setAttribute('aria-label','Chercher une application');
      const results=node('div');const searchButton=node('button','Chercher les applications');searchButton.type='button';
      searchButton.onclick=async()=>{try{
        const page=await request('/api/apps?limit=25&query='+encodeURIComponent(search.value));results.replaceChildren();
        for(const app of page.apps){
          const box=node('input');box.type='checkbox';box.style.width='auto';box.checked=selection.has(app.id);
          box.onchange=()=>{all.checked=false;if(box.checked)selection.add(app.id);else selection.delete(app.id);updateCount();};
          const row=node('label',' '+app.name);row.prepend(box);results.append(row,node('br'));
        }
        if(page.next_offset!==null)results.append(node('p','Affinez la recherche pour retrouver les autres applications.'));
      }catch(e){notice(e.message);}};
      card.append(search,searchButton,results);
      const save=node('button','Enregistrer');save.type='button';save.onclick=async()=>{try{
        await request('/api/connectors/'+c.id,{name:name.value,enabled:enabled.checked,app_ids:all.checked?null:[...selection]},'PUT');
        notice('Connecteur enregistré.');await loadConnectors(connectorOffset);
      }catch(e){notice(e.message);}};card.append(save);$("connectorrows").append(card);
    }
  }catch(e){notice(e.message);}
}
$("connectors").onclick=()=>{$("connectorpanel").hidden=false;loadConnectors();};
$("connectorsearch").onclick=()=>loadConnectors();
$("connectorprev").onclick=()=>loadConnectors(Math.max(0,connectorOffset-25));
$("connectornext").onclick=()=>{if(connectorNext!==null)loadConnectors(connectorNext);};
