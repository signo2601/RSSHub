# Gruzzolo

La tua app personale per seguire gli investimenti, ispirata a getquin. Funziona su iPhone (installata dalla schermata Home) e sul PC.

## Cosa fa

- **Portafoglio**: valore totale, variazione di oggi, grafico di valore e rendimento, posizioni con prezzi in tempo reale, conti separati (es. DEGIRO, Scalable Capital).
- **Mercati**: cerchi qualsiasi titolo per nome, ticker o ISIN (azioni, ETF, fondi, crypto, indici) con prezzi e grafici da Yahoo Finance; watchlist con prezzo obiettivo; catalogo di 200 titoli popolari.
- **Report** con 6 fogli:
  1. **Riepilogo**: saldo finale e iniziale, TWR, liquidità, P&L realizzato/non realizzato/cambio, attivo vs benchmark, flussi netti, IRR, volatilità, Sharpe, CAGR, drawdown massimo.
  2. **Analisi visiva**: curva equity, rendimenti mensili, rendimento attivo, evoluzione dell'allocazione, drawdown, volatilità rolling.
  3. **Composizione**: ripartizione per classe, titolo, settore, regione e valuta; diversificazione.
  4. **Dividendi & Fixed Income**: incassi, rendimento, calendario, cumulati, previsione 12 mesi, dividendi da registrare.
  5. **Costi d'intermediazione**: commissioni, AutoFX, connectivity fee, TER, imposte, bollo 0,20%, zaino fiscale (minusvalenze compensabili).
  6. **Gestione del rischio**: rischio dell'allocazione attuale (VaR, beta, alpha, Sortino…) e frontiera efficiente di Markowitz.
- **Altro**: conti, import CSV da DEGIRO e Scalable Capital, sincronizzazione cifrata iPhone ↔ PC, backup, tema chiaro/scuro.

Ogni indicatore ha il pulsante **i** con una spiegazione semplice.

## Metterla online (gratis, 10 minuti)

Per avere i prezzi reali serve un piccolo server: lo fornisce Cloudflare Pages, gratis. Il server chiede i prezzi a Yahoo Finance per conto dell'app.

1. Crea un account gratuito su [cloudflare.com](https://dash.cloudflare.com/sign-up).
2. Nel pannello: **Workers & Pages** → **Create** → scheda **Pages** → **Connect to Git** → collega GitHub e scegli il repository `RSSHub`.
3. Impostazioni del progetto:
   - **Production branch**: il branch con l'app (es. `claude/getquin-like-personal-app-pbsn86`)
   - **Framework preset**: None
   - **Build command**: `exit 0`
   - **Build output directory**: `.`
   - **Root directory (advanced)**: `gruzzolo`
4. **Save and Deploy**. Dopo un minuto avrai un indirizzo tipo `https://gruzzolo.pages.dev`.

### Sincronizzazione iPhone ↔ PC (facoltativa)

Serve uno spazio dati sul server:

1. Cloudflare → **Storage & Databases** → **KV** → **Create** → nome `gruzzolo`.
2. Progetto Pages → **Settings** → **Bindings** → **Add** → **KV namespace** → Variable name `GRUZZOLO_KV`, namespace `gruzzolo`.
3. **Deployments** → rifai il deploy dell'ultima versione.
4. Nell'app: **Altro → Sincronizzazione** → scegli una frase segreta (almeno 10 caratteri) e attiva. Sull'altro dispositivo scrivi la stessa frase.

I dati viaggiano cifrati con la tua frase: il server conserva solo dati illeggibili. Se perdi la frase, la copia sincronizzata non è recuperabile (i dati restano sui dispositivi).

## Installarla

- **iPhone**: apri l'indirizzo in Safari → **Condividi** → **Aggiungi alla schermata Home**.
- **PC**: apri l'indirizzo in Chrome o Edge → icona **Installa** nella barra degli indirizzi.

## Importare da DEGIRO e Scalable Capital

**Altro → Importa da broker**, poi scegli il file CSV:

- **DEGIRO**: Attività → Transazioni → Esporta CSV (operazioni); Attività → Estratto conto → Esporta CSV (dividendi, depositi, commissioni).
- **Scalable Capital**: Transazioni → Esporta CSV.

Le operazioni già presenti non vengono duplicate.

## Dove stanno i dati

- **Le tue operazioni**: sul dispositivo (memoria del browser) e, se attivi la sincronizzazione, cifrate su Cloudflare. Fai ogni tanto **Altro → Esporta backup**.
- **I prezzi**: da Yahoo Finance, con circa 15 minuti di ritardo. Servono a scopo informativo: i calcoli di rischio, frontiera e zaino fiscale sono stime, non consigli d'investimento né consulenza fiscale.
- **Senza server** (ad esempio nell'anteprima su Claude): l'app funziona con prezzi inseriti a mano e con il portafoglio di esempio.

## Per sviluppatori

```bash
cd gruzzolo
node dev/server.mjs              # app + /api su http://127.0.0.1:8787
node --test tests/*.test.mjs     # test
node dev/build-artifact.mjs      # versione in un solo file per Claude
```

Struttura e contratti tra i moduli: [ARCHITECTURE.md](ARCHITECTURE.md).
