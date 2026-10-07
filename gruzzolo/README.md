# Gruzzolo

App personale per seguire i propri investimenti, ispirata a getquin.
Un solo file (`index.html`), nessuna installazione, nessun collegamento a banche o servizi esterni.

## Cosa fa

- **Portafoglio**: valore totale, grafico di valore e rendimento (1S, 1M, 3M, YTD, 1A, 3A, Max), plus/minus latente e realizzata, posizioni aperte e chiuse.
- **Più portafogli** (es. "Conto titoli", "Crypto", "Pensione") o la vista "Tutti i portafogli".
- **Transazioni**: acquisti, vendite, dividendi/cedole, depositi e prelievi di liquidità, con commissioni e tasse.
- **Analisi**: ripartizione per classe, titolo, settore, regione e valuta; diversificazione; migliori e peggiori; costi.
- **Dividendi**: ricevuti per mese e per titolo, previsione annua, rendimento attuale e sul costo.
- **Watchlist** con prezzo obiettivo.
- **Modalità privacy** (icona occhio) per nascondere gli importi.
- **Backup**: esporta e importa tutti i dati in JSON, esporta le transazioni in CSV.

I prezzi si inseriscono a mano: dal dettaglio di un titolo o con "Aggiorna prezzi" per tutti insieme.
Il prezzo medio di carico usa il metodo del costo medio; il rendimento percentuale è time-weighted (TWR), come nelle app di portafoglio.

## Come usarla sul telefono

**Opzione 1, la più semplice**: apri il link dell'artifact su Claude. I dati restano nel tuo spazio privato e li vedi da qualsiasi dispositivo.

**Opzione 2, come app installata e offline**: pubblica questa cartella su un sito statico gratuito, poi aprila dal telefono e scegli "Aggiungi a schermata Home".
- Netlify Drop: trascina la cartella `gruzzolo` su https://app.netlify.com/drop
- Oppure GitHub Pages: Settings → Pages → scegli il branch, poi apri `.../gruzzolo/`

In questa modalità i dati sono salvati solo nel browser del telefono: esporta un backup ogni tanto.

## File

| File | A cosa serve |
|---|---|
| `index.html` | Tutta l'app: grafica (CSS), schermate e calcoli (JavaScript) |
| `manifest.webmanifest` | Nome e icona quando la installi sul telefono |
| `sw.js` | Permette di aprirla anche senza connessione |
| `icon.svg`, `icon-*.png` | Icone |
