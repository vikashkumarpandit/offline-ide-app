/* sw.js — lets the Python worker wait (synchronously) for input() answers.
   The worker does a blocking XHR to /__stdin__?id=...; we hold that request open
   until the main thread posts the typed text. */
const waiting = new Map();
const early = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type !== "input-reply") return;
  const w = waiting.get(d.id);
  if (w) { waiting.delete(d.id); w(d.value); }
  else early.set(d.id, d.value); // reply arrived before the request
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (!u.pathname.endsWith("/__stdin__")) return;
  const id = u.searchParams.get("id");
  const reply = (v) => new Response(JSON.stringify({ value: v }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
  if (id === "probe") { e.respondWith(reply("ok")); return; }
  if (early.has(id)) { const v = early.get(id); early.delete(id); e.respondWith(reply(v)); return; }
  e.respondWith(new Promise((res) => waiting.set(id, (v) => res(reply(v)))));
});
