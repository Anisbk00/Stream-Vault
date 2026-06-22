import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "StreamVault — Premium Films & Series Streaming",
  description:
    "Stream the latest movies and TV series in stunning quality. Discover trending content, build your watchlist, and enjoy a cinema-like experience.",
  keywords: [
    "StreamVault",
    "streaming",
    "movies",
    "TV series",
    "films",
    "watch online",
    "premium streaming",
  ],
  authors: [{ name: "StreamVault" }],
  icons: {
    icon: [
      { url: "/sv-favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/sv-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/sv-touch-180.png", sizes: "180x180" },
      { url: "/sv-touch-167.png", sizes: "167x167" },
      { url: "/sv-touch-152.png", sizes: "152x152" },
      { url: "/sv-touch-120.png", sizes: "120x120" },
    ],
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "StreamVault",
  },
  openGraph: {
    title: "StreamVault — Premium Streaming",
    description: "Stream the latest movies and TV series in stunning quality.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "StreamVault",
    description: "Premium Films & Series Streaming",
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-touch-fullscreen": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "contain",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#080808" },
    { media: "(prefers-color-scheme: dark)", color: "#080808" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Inject runtime Supabase config so the client always uses the latest
  // env vars (not build-time baked values). Server components read
  // process.env at request time, so this survives env var changes
  // without needing a rebuild.
  const runtimeConfig = JSON.stringify({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  });

  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <head>
        {/* ── EXPLICIT PWA icon <link> tags ──
            iOS Safari is extremely picky about apple-touch-icon discovery.
            Using NEW filenames (sv-*) because iOS aggressively caches icons
            by URL — old filenames had broken icons cached for days. */}
        <link rel="icon" type="image/png" sizes="32x32" href="/sv-favicon.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/sv-icon-192.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/sv-touch-180.png" />
        <link rel="apple-touch-icon" sizes="167x167" href="/sv-touch-167.png" />
        <link rel="apple-touch-icon" sizes="152x152" href="/sv-touch-152.png" />
        <link rel="apple-touch-icon" sizes="120x120" href="/sv-touch-120.png" />
        <link rel="apple-touch-icon-precomposed" sizes="180x180" href="/sv-touch-180.png" />
        {/* CRITICAL: iOS Safari needs this meta tag to recognize PWA.
            Next.js appleWebApp.capable may not generate it reliably. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
              // ── PWA ICON DIAGNOSTIC ──
              // Logs everything iOS Safari sees about icons to console.
              // Check Safari Web Inspector (Develop > [device] > Console) after page load.
              window.addEventListener('load', function() {
                setTimeout(function() {
                  console.group('%c[PWA Icon Diagnostic]', 'color: #E50914; font-weight: bold; font-size: 14px');

                  // 1. Check <link> tags in DOM
                  var linkTags = document.querySelectorAll('link[rel*="icon"], link[rel*="apple"]');
                  console.log('%c1. <link> tags found in DOM:', 'font-weight: bold');
                  linkTags.forEach(function(link) {
                    console.log('  ', link.rel, link.getAttribute('sizes') || 'no-size', '→', link.href);
                  });
                  if (linkTags.length === 0) {
                    console.error('  ⚠️ NO <link> icon tags found! iOS will NOT find icons.');
                  }

                  // 2. Check manifest
                  console.log('%c2. Manifest link:', 'font-weight: bold');
                  var manifestLink = document.querySelector('link[rel="manifest"]');
                  if (manifestLink) {
                    console.log('  ✓ manifest href:', manifestLink.href);
                  } else {
                    console.error('  ⚠️ NO <link rel="manifest"> found!');
                  }

                  // 3. Fetch and validate manifest.json
                  console.log('%c3. Fetching manifest.json...', 'font-weight: bold');
                  fetch('/manifest.json', { cache: 'no-store' })
                    .then(function(r) {
                      console.log('  Status:', r.status, r.statusText);
                      console.log('  Content-Type:', r.headers.get('Content-Type'));
                      return r.text();
                    })
                    .then(function(text) {
                      try {
                        var m = JSON.parse(text);
                        console.log('  name:', m.name);
                        console.log('  short_name:', m.short_name);
                        console.log('  display:', m.display);
                        console.log('  start_url:', m.start_url);
                        console.log('  icons:', JSON.stringify(m.icons, null, 2));
                        if (!m.icons || m.icons.length === 0) {
                          console.error('  ⚠️ manifest has NO icons!');
                        }
                        // 4. Test each icon URL from manifest
                        console.log('%c4. Testing manifest icon URLs:', 'font-weight: bold');
                        (m.icons || []).forEach(function(icon) {
                          var url = new URL(icon.src, location.origin).href;
                          var img = new Image();
                          img.onload = function() {
                            console.log('  ✓', icon.src, icon.sizes, icon.purpose, '→ loaded', img.naturalWidth + 'x' + img.naturalHeight);
                          };
                          img.onerror = function() {
                            console.error('  ✗', icon.src, icon.sizes, '→ FAILED TO LOAD');
                          };
                          img.src = url;
                          // Also do a fetch to check headers
                          fetch(url, { method: 'HEAD', cache: 'no-store' })
                            .then(function(r) {
                              if (!r.ok) {
                                console.error('  ✗', icon.src, '→ HTTP', r.status, r.statusText);
                              } else {
                                var ct = r.headers.get('Content-Type');
                                var cl = r.headers.get('Content-Length');
                                if (ct && ct.indexOf('image/png') === -1) {
                                  console.error('  ⚠️', icon.src, '→ Wrong Content-Type:', ct, '(expected image/png)');
                                }
                                console.log('  HEAD', icon.src, '→', r.status, 'Content-Type:', ct, 'Size:', cl);
                              }
                            })
                            .catch(function(e) {
                              console.error('  ✗', icon.src, '→ fetch error:', e.message);
                            });
                        });
                      } catch(e) {
                        console.error('  ⚠️ manifest.json parse error:', e.message);
                        console.log('  Raw text (first 500 chars):', text.substring(0, 500));
                      }
                    })
                    .catch(function(e) {
                      console.error('  ⚠️ manifest.json fetch failed:', e.message);
                    });

                  // 5. Test apple-touch-icon specifically
                  console.log('%c5. Testing apple-touch-icon.png directly:', 'font-weight: bold');
                  var testImg = new Image();
                  testImg.onload = function() {
                    console.log('  ✓ apple-touch-icon.png loaded:', testImg.naturalWidth + 'x' + testImg.naturalHeight);
                    // Check for transparency by drawing to canvas
                    try {
                      var c = document.createElement('canvas');
                      c.width = testImg.naturalWidth;
                      c.height = testImg.naturalHeight;
                      var ctx = c.getContext('2d');
                      ctx.drawImage(testImg, 0, 0);
                      var data = ctx.getImageData(0, 0, c.width, c.height).data;
                      var transparent = 0;
                      for (var i = 3; i < data.length; i += 4) {
                        if (data[i] < 255) transparent++;
                      }
                      if (transparent > 0) {
                        console.error('  ⚠️ apple-touch-icon.png has', transparent, 'transparent pixels! iOS will REJECT this icon.');
                      } else {
                        console.log('  ✓ Zero transparent pixels — good');
                      }
                    } catch(e) {
                      console.warn('  Could not check transparency (CORS):', e.message);
                    }
                  };
                  testImg.onerror = function() {
                    console.error('  ✗ apple-touch-icon.png FAILED TO LOAD');
                  };
                  testImg.src = '/apple-touch-icon.png?v=' + Date.now();

                  // 6. Check meta tags
                  console.log('%c6. Meta tags for PWA:', 'font-weight: bold');
                  var appleMobile = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
                  var appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
                  console.log('  apple-mobile-web-app-capable:', appleMobile ? appleMobile.content : 'NOT SET');
                  console.log('  apple-mobile-web-app-title:', appleTitle ? appleTitle.content : 'NOT SET');

                  // 7. Check service worker
                  console.log('%c7. Service Worker:', 'font-weight: bold');
                  if ('serviceWorker' in navigator) {
                    navigator.serviceWorker.getRegistration().then(function(reg) {
                      if (reg) {
                        console.log('  ✓ Registered:', reg.scope);
                        console.log('  Active SW URL:', reg.active ? reg.active.scriptURL : 'none');
                      } else {
                        console.error('  ⚠️ No service worker registered');
                      }
                    });
                  }

                  // 8. Check if standalone mode
                  console.log('%c8. Display mode:', 'font-weight: bold');
                  console.log('  standalone:', window.matchMedia('(display-mode: standalone)').matches);
                  console.log('  navigator.standalone:', navigator.standalone);

                  console.groupEnd();
                }, 2000);
              });
            })();
            `,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__SV_CONFIG__=${runtimeConfig}`,
          }}
        />
        {/* SERVICE WORKER: inline registration in <head> — runs BEFORE any JS bundles.
            This is critical for iOS PWA offline: if SW registration were in a React
            component, it would never execute when app JS fails to load offline,
            leaving the user stuck on Safari's native "can't open page" error.

            Flow:
            1. FORCE-UPDATE (once per SW version): nukes old SWs/caches, reloads.
            2. REGISTER: registers /sw.js (stable URL, no cache-bust).
            3. CACHE-WARMING: after page load, sends all loaded resource URLs to SW.
            4. The SW handles navigation with stale-while-revalidate + offline.html fallback.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
              if(!('serviceWorker' in navigator))return;

              // ── Force-update: runs ONCE when SW version changes ──
              // Nukes all old SW registrations + caches, then reloads.
              // On reload, this script re-runs but the flag is set → skips to registration.
              var FORCE_FLAG='sv_sw_v24';
              if(!localStorage.getItem(FORCE_FLAG)){
                if(navigator.onLine){
                  navigator.serviceWorker.getRegistrations().then(function(regs){
                    if(regs.length===0){
                      localStorage.setItem(FORCE_FLAG,'1');
                      registerSW();
                      return;
                    }
                    Promise.all(regs.map(function(r){return r.unregister();})).then(function(){
                      if('caches' in window){
                        caches.keys().then(function(ks){
                          ks.forEach(function(k){caches.delete(k);});
                        });
                      }
                      localStorage.setItem(FORCE_FLAG,'1');
                      window.location.reload();
                    });
                  });
                  return;
                } else {
                  // Offline + no flag → old SW might still be active, try to use it
                  // Don't clear caches — we need them!
                  localStorage.setItem(FORCE_FLAG,'1');
                }
              }

              // ── Register SW ──
              function registerSW(){
                navigator.serviceWorker.register('/sw.js').then(function(reg){
                  if(reg.waiting) reg.waiting.postMessage({type:'SKIP_WAITING'});
                  reg.addEventListener('updatefound',function(){
                    var w=reg.installing;
                    if(w){
                      w.addEventListener('statechange',function(){
                        if(w.state==='installed'&&navigator.serviceWorker.controller){
                          w.postMessage({type:'SKIP_WAITING'});
                        }
                      });
                    }
                  });
                }).catch(function(){});
              }

              registerSW();

              // ── Cache warming: send all loaded resources to SW ──
              // Catches dynamically imported chunks that weren't in the initial HTML.
              // Uses performance.getEntriesByType to find ALL fetched resources.
              if(navigator.onLine){
                window.addEventListener('load',function(){
                  setTimeout(function(){
                    if(!navigator.serviceWorker.controller)return;
                    var origin=location.origin;
                    var urls=[];
                    var entries=performance.getEntriesByType('resource');
                    for(var i=0;i<entries.length;i++){
                      var name=entries[i].name;
                      if(name.indexOf(origin)===0){
                        var path=name.substring(origin.length);
                        if(path.indexOf('/_next/')===0&&path.indexOf('/api/')!==0){
                          urls.push(path);
                        }
                      }
                    }
                    if(urls.length>0){
                      navigator.serviceWorker.controller.postMessage({
                        type:'WARM_CACHE',
                        urls:urls
                      });
                    }
                  },3000);
                });
              }
            })();`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#080808] text-[#F5F5F5]`}
        style={{ minHeight: '100dvh', overflow: 'hidden' }}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
