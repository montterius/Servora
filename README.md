# Servora

Clientul scanează codul QR al restaurantului, scrie numărul de pe bon și e anunțat pe telefon (sunet + vibrație) când comanda e gata.

## Ce e în acest folder

- `server.js` — „creierul”: ține minte restaurantele și comenzile (în MongoDB) și face codurile QR.
- `package.json` — lista „uneltelor” (librăriilor) de care are nevoie serverul.
- `public/index.html` — pagina de prezentare Servora.
- `public/client.html` — pagina pe care ajunge clientul după ce scanează QR-ul (`/r/numele-restaurantului`).
- `public/kitchen.html` — panoul restaurantului (bucătăria marchează comenzile „Gata”).
- `public/admin.html` — pagina ta: creezi restaurante și le descarci codul QR.
- `public/print.html` — cardul cu QR, gata de printat.
- `public/servora.css` — culorile și stilul comun.
- `public/sw.js` — codul din fundal pentru notificările push.

## Setări pe Render (Environment Variables)

| Nume | Ce pui acolo |
|---|---|
| `MONGODB_URI` | Aceeași adresă ca la OrderPing (se poate refolosi) |
| `MONGODB_DB` | `servora` (opțional — e valoarea implicită) |
| `JWT_SECRET` | Un text lung, la întâmplare |
| `ADMIN_KEY` | Parola ta pentru `/admin.html` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Aceleași ca la OrderPing (opțional — pentru notificări push) |

Build command: `npm install` · Start command: `npm start`
