/* Offline cache for the Lectro dashboard.

   The point of this file: once the page has been opened over https even once,
   everything it needs is stored on the phone. After that the dashboard opens
   from the home screen with no internet, no PC and no server - while still
   counting as a secure page, which is what lets it use Bluetooth. */

var CACHE = "lectro-v1";

var FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", function(e){
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      // Don't let one missing file abort the whole install.
      return Promise.all(FILES.map(function(f){
        return c.add(f).catch(function(){});
      }));
    })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(e){
  if (e.request.method !== "GET") return;

  e.respondWith(
    caches.match(e.request).then(function(hit){
      if (hit) return hit;
      return fetch(e.request).then(function(resp){
        if (resp && resp.status === 200 && resp.type === "basic"){
          var copy = resp.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
        }
        return resp;
      }).catch(function(){
        // Offline and not cached: fall back to the dashboard itself.
        return caches.match("./index.html");
      });
    })
  );
});
