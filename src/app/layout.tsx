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
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
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
  const runtimeConfig = JSON.stringify({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  });

  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <head>
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
              var FORCE_FLAG='sv_sw_v26';
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
