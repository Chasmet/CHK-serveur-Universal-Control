import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core.mjs";

const ui = ["ui_status","ui_inspect","ui_capture","ui_click","ui_tap",
  "ui_long_press","ui_swipe","ui_type","ui_back"];
const caps = ui.map(name => ({name, readOnly: ["ui_status","ui_inspect","ui_capture"].includes(name)}));

test("visual tools need paired worker, are scoped to CHK, and keep trading approvals", async t => {
  const dir = await mkdtemp(join(tmpdir(), "chk-visual-"));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const store = new Store(join(dir, "db.json"));
  await store.init();
  const crypto = await store.registerApp({name:"CHK Crypto Analyse 2",
    capabilities:[{name:"portfolio_snapshot",readOnly:true},{name:"trade",readOnly:false}]});
  const other = await store.registerApp({name:"Other app",
    capabilities:[{name:"ui_tap",readOnly:false}]});
  await assert.rejects(() => store.extendVisualCapabilities(crypto.id,
    [{name:"ui_tap",readOnly:true}]), /invalid_visual_capabilities/);
  const update = await store.extendVisualCapabilities(crypto.id, {capabilities:caps});
  assert.equal(update.ok, true);
  assert.equal(update.capability_count, 11);
  const screenshot = await store.submit({app_id:crypto.id,action:"ui_capture",args:{}});
  assert.equal(screenshot.state,"queued");
  const tap = await store.submit({app_id:crypto.id,action:"ui_tap",args:{x:200,y:300}});
  assert.equal(tap.state,"queued");
  const forbidden = await store.submit({app_id:crypto.id,action:"trade",args:{}});
  assert.equal(forbidden.state,"pending_approval");
  const otherTap = await store.submit({app_id:other.id,action:"ui_tap",args:{x:100,y:100}});
  assert.equal(otherTap.state,"pending_approval");
  assert.equal((await store.poll(crypto.id)).action, "ui_capture");
  await store.result(crypto.id,screenshot.id, {ok:true,type:"image/jpeg",
    jpegBase64:"a".repeat(20000)});
  assert.equal(store.getJob(screenshot.id).state, "completed");
  assert.equal(store.getJob(screenshot.id).result.jpegBase64.length,20000);
});
