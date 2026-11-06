# Gruzzolo

La tua app personale per seguire gli investimenti, ispirata a getquin. Vive sul tuo **iPhone**: la installi una volta dalla schermata Home e poi funziona anche senza internet. I tuoi dati restano solo sul telefono.

## Cosa fa

- **Portafoglio**: valore totale, variazione di oggi, grafico di valore e rendimento, posizioni con i prezzi aggiornati, conti separati (es. DEGIRO, Scalable Capital).
- **Mercati**: il monitoraggio dell'economia, in quattro pagine:
  - **Panoramica**: indici di Borsa del mondo, rendimenti dei titoli di Stato (con lo spread sul Bund), obbligazioni delle aziende AAA (Microsoft, Johnson & Johnson), materie prime, cambi e le principali crypto, con la variazione di oggi, della settimana, del mese, da inizio anno o dell'anno.
  - **Heatmap**: le aziende di un indice (S&P 500, FTSE MIB, DAX, Euro Stoxx 50…) come rettangoli grandi quanto il loro valore, verdi o rossi secondo la variazione; tocchi un settore per ingrandirlo.
  - **Curve**: le curve dei rendimenti dei titoli di Stato dei principali Paesi, confrontate tra loro e con ieri, un mese o un anno fa.
  - **Macro**: la mappa del mondo con inflazione, tassi delle banche centrali, PIL, crescita, disoccupazione e debito/PIL, con la classifica dei Paesi (G20, G7, area euro, continenti).
- **Report** con 6 fogli: riepilogo (TWR, IRR, Sharpe, drawdown…), analisi visiva, composizione, dividendi e cedole, costi e imposte (bollo, zaino fiscale), gestione del rischio (VaR, beta, frontiera di Markowitz).
- **Altro**: conti, import dei file CSV di DEGIRO e Scalable Capital, aliquote, backup, tema chiaro/scuro, «Dove sono i tuoi dati».

Ogni indicatore ha il pulsante **i** con una spiegazione semplice.

## Dove sono i tuoi dati

- **Solo sul tuo iPhone.** Conti, operazioni, titoli, impostazioni e prezzi manuali sono salvati nella memoria dell'app, sul telefono. Non c'è un account, non c'è un cloud, non c'è nessuna copia su un server.
- **Cosa passa da internet**: solo il nome, il ticker o l'ISIN dei titoli (per esempio `VWCE.DE`), quando l'app chiede i prezzi pubblici al **suo** piccolo server, che li prende da Yahoo Finance; per la scheda Mercati, solo le liste fisse di indici, valute e Paesi, che il server legge da TradingView (anche i loghi delle aziende passano dal server dell'app). Importi, quantità, conti e operazioni non escono mai dal telefono.
- **I caratteri e tutti i file dell'app** sono dentro l'app: non vengono scaricati da altri siti.
- In **Altro → Dove sono i tuoi dati** vedi se iOS ha concesso la «memoria permanente» (i dati non vengono cancellati per fare spazio) e quanto spazio usa l'app.

## Metterla online (una volta sola, gratis)

L'app è un piccolo sito: va pubblicata una volta su internet, così Safari la può aprire e installare. Si usa **Cloudflare Pages**, gratuito. Il sito contiene **solo il programma** (e il piccolo server dei prezzi), **mai i tuoi dati**.

1. Crea un account gratuito su [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. Nel menu a sinistra apri **Workers & Pages** → **Create** (o «Create application»).
3. Scegli la scheda **Pages** (se vedi solo «Workers», cerca il link «Pages» / «Looking to deploy Pages? Get started»), poi **Connect to Git** («Import an existing Git repository»).
4. Collega il tuo account GitHub e scegli il repository **RSSHub**.
5. Impostazioni del progetto:
   - **Production branch**: `claude/getquin-like-personal-app-pbsn86`
   - **Framework preset**: `None`
   - **Build command**: `exit 0`
   - **Build output directory**: `.`
   - **Root directory (advanced)**: `gruzzolo`
6. Tocca **Save and Deploy**. Dopo un minuto avrai un indirizzo tipo `https://gruzzolo.pages.dev`: è quello da aprire sull'iPhone.

Non serve configurare altro: niente database, niente chiavi.

## Installarla sull'iPhone

1. Apri l'indirizzo (es. `https://gruzzolo.pages.dev`) in **Safari**, con internet attivo.
2. Tocca **Condividi** (il quadrato con la freccia verso l'alto; se non lo vedi, tocca prima **…** in basso).
3. Scorri e scegli **Aggiungi alla schermata Home**. Se compare «Apri come app web», lascialo attivo. Tocca **Aggiungi**.
4. Da ora apri Gruzzolo **sempre dall'icona** sulla schermata Home, non da Safari: l'app installata ha una memoria tutta sua.
5. Alla **prima apertura** resta online qualche secondo: l'app si salva sul telefono per funzionare anche offline.
6. Si apre con un portafoglio di esempio: tocca **Inizia da zero** e crea i tuoi conti, oppure importa i file del broker (**Altro → Importa da broker**).

Perché proprio dall'icona? In Safari, iOS può cancellare i dati dei siti che non apri per 7 giorni; l'app sulla schermata Home no, e può ricevere la «memoria permanente».

## Backup

Il backup è un file `.json` con tutti i tuoi dati. Fallo ogni tanto (l'app te lo ricorda dopo 30 giorni).

- **Salvare**: **Altro → Esporta backup** → si apre Condividi → **Salva su File** → **Sul mio iPhone** → **Salva**.
- **Ripristinare**: **Altro → Importa backup** → scegli il file nell'app File. Sostituisce i dati attuali (anche su un iPhone nuovo).
- Un backup che resta solo sull'iPhone ti salva se elimini l'app per errore, non se perdi il telefono: ogni tanto copiane uno anche altrove (AirDrop, una chiavetta, oppure iCloud Drive se per te va bene il cloud).

## Senza internet

- Tutto funziona: portafoglio, report, operazioni (puoi aggiungerle e modificarle), con gli **ultimi prezzi scaricati**.
- Quando torni online i prezzi si aggiornano da soli (o tocca l'icona ↻ in alto, o **Altro → Aggiorna prezzi ora**).
- Offline non puoi cercare titoli nuovi su Yahoo Finance; il catalogo dei titoli popolari funziona comunque.
- La scheda Mercati mostra gli ultimi dati scaricati, con l'ora in cui li hai scaricati.

## Aggiornamenti

Quando il codice dell'app cambia e Cloudflare lo ripubblica, apri Gruzzolo **con internet attivo due volte**: la prima scarica la nuova versione, la seconda la usa. I dati restano dove sono.

## Consigli di sicurezza

- Proteggi l'iPhone con **codice e Face ID**: chi sblocca il telefono può aprire l'app.
- In pubblico usa l'**occhio** in alto (o **Altro → Nascondi gli importi**): gli euro diventano •••••.
- **Se elimini l'icona di Gruzzolo, iOS cancella anche i suoi dati.** Prima esporta un backup.
- Il file di backup contiene tutti i tuoi dati: conservalo dove lo terresti per un estratto conto.

## Importare da DEGIRO e Scalable Capital

**Altro → Importa da broker**, poi scegli il file CSV (scaricalo dal sito del broker e salvalo in File):

- **DEGIRO**: Attività → Transazioni → Esporta CSV (operazioni); Attività → Estratto conto → Esporta CSV (dividendi, depositi, commissioni).
- **Scalable Capital**: Transazioni → Esporta CSV.

Il file viene letto sul telefono; le operazioni già presenti non vengono duplicate.

I prezzi arrivano con circa 15 minuti di ritardo e servono a scopo informativo: i calcoli di rischio, frontiera e zaino fiscale sono stime, non consigli d'investimento né consulenza fiscale. I dati della scheda Mercati sono di TradingView (stesso ritardo); la mappa usa Natural Earth e i nomi dei Paesi di mledoze/countries (licenza ODbL).

## Per sviluppatori

```bash
cd gruzzolo
node dev/server.mjs              # app + /api su http://127.0.0.1:8787
HOST=0.0.0.0 node dev/server.mjs # raggiungibile dall'iPhone sulla stessa rete Wi-Fi (http: niente modalità offline)
node --test tests/*.test.mjs     # test
node dev/build-artifact.mjs      # anteprima in un solo file per Claude (salva i dati solo nel browser che la apre)
```

Il server (`functions/api/[[path]].js`) è in sola lettura: risponde a `/api/health`, `/api/search`, `/api/chart`, `/api/quotes` e `/api/eco/*` (scheda Mercati) con dati pubblici di mercato e non conserva nulla. `node dev/build-world.mjs` rigenera la mappa del mondo (`js/world.js`). `sw.js` salva tutti i file dell'app per l'uso offline. Struttura e contratti tra i moduli: [ARCHITECTURE.md](ARCHITECTURE.md).
