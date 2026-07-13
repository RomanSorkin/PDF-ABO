# ABO/GPC Viewer

Prohlížeč českých bankovních výpisů ve formátu **ABO/GPC** (věty `074` hlavička a
`075` položky, kódování Windows-1250, řádky po 128 znacích). Parsuje se vše
v prohlížeči — žádná data se nikam neposílají.

- Dekódování CP1250 → UTF-8 (`Nůž`, `Suchánek`, `Silovská` …)
- Hlavička jako přehledová karta + kontrola, že zůstatky a obraty sedí
- Tabulka položek: hledání, filtr příjmy/výdaje, řazení, živé součty
- Inspektor surového 128znakového záznamu s vyznačenými poli
- Podpora souborů s více výpisy (více vět `074`)

**Převod PDF → GPC** (`/prevod.html`): nahraješ PDF výpis z Raiffeisenbank, text
se vytáhne přes pdf.js přímo v prohlížeči (nic se nikam neposílá), rozparsuje se
hlavička i pohyby, ověří se rekonciliace (příjmy/výdaje vs. konečný zůstatek)
a vygeneruje se GPC v CP1250 ke stažení. Panel „Rozpoznaný text" slouží k ladění,
kdyby jiný výpis nesedl.

## Struktura

```
abo-gpc-viewer/
├── public/
│   ├── index.html    # prohlížeč GPC výpisů (funguje i sám o sobě)
│   ├── prevod.html   # převod PDF (Raiffeisenbank / Air Bank) → GPC, v prohlížeči
│   ├── parovani.html # párování pohybů z GPC s vydanými doklady (XML)
│   └── faktury.html  # faktury Zásilkovny přes server-side proxy
├── server.js         # nulové závislosti, servíruje public/ + Zásilkovna proxy
├── package.json      # npm start -> node server.js
├── railway.json      # start command + healthcheck /healthz
└── .nvmrc            # Node 18
```

Endpoint `POST /api/convert` je zatím záměrně stub (`501`) — místo pro budoucí
převod PDF → GPC.

### Faktury Zásilkovny (server-side proxy)

Stránka `faktury.html` čte faktury přes backend, aby se API klíč a heslo nikdy
nedostaly do prohlížeče. Nastav v Railway → Variables:

```
ZASILKOVNA_KEY       = API klíč   (Klientská sekce → Zákaznická podpora)
ZASILKOVNA_PASSWORD  = API heslo
APP_TOKEN            = (volitelné) tajný řetězec; když je nastavený,
                       /api/zasilkovna/* vyžaduje hlavičku x-app-token
```

Proxy endpointy (klíč/heslo se doplní na serveru, nikdy se nevrací ani neloguje):
`/api/zasilkovna/status`, `/invoices`, `/packet`, `/packet-pohoda`, `/pdf`.

## Spuštění lokálně

Potřebuješ jen Node 18+ (žádný `npm install`, nejsou závislosti):

```bash
npm start
# -> http://localhost:3000
```

Volitelně jiný port: `PORT=8080 npm start`.

## Nasazení na GitHub

```bash
git init
git add .
git commit -m "ABO/GPC viewer"
git branch -M main
git remote add origin https://github.com/<uzivatel>/abo-gpc-viewer.git
git push -u origin main
```

## Nasazení na Railway

1. Na https://railway.app → **New Project → Deploy from GitHub repo** a vyber
   tento repozitář.
2. Railway detekuje Node přes `package.json`, sestaví přes Nixpacks a spustí
   `npm start`. Nic dalšího nastavovat nemusíš — server poslouchá na
   `process.env.PORT` a na `0.0.0.0`.
3. V záložce **Settings → Networking → Generate Domain** si vygeneruj veřejnou
   adresu. Healthcheck běží na `/healthz`.

Alternativně přes Railway CLI:

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

## Statická varianta (GitHub Pages / Netlify …)

Server není nutný — stačí obsah složky `public/`. Např. na GitHub Pages nastav
zdroj na větev `main`, složku `/public` (nebo `public/index.html` přejmenuj do
kořene). Soubor je plně samostatný.
